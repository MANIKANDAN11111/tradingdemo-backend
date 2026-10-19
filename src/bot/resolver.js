import { request, growwHeldBack, growwHoldbackReason } from '../growwClient.js';
import { fyers, fyersBreakerStatus } from '../fyersClient.js';

/** NIFTY → NSE:NIFTY50-INDEX, BANKNIFTY → NSE:NIFTYBANK-INDEX, etc. */
function fyersUnderlying(underlying) {
  const u = String(underlying || '').toUpperCase();
  if (u === 'NIFTY' || u === 'NIFTY50') return 'NSE:NIFTY50-INDEX';
  if (u === 'BANKNIFTY' || u === 'NIFTYBANK') return 'NSE:NIFTYBANK-INDEX';
  if (u === 'FINNIFTY' || u === 'NIFTYFIN') return 'NSE:NIFTYFIN-INDEX';
  if (u === 'MIDCPNIFTY') return 'NSE:NIFTYMID-INDEX';
  if (u === 'SENSEX') return 'BSE:SENSEX-INDEX';
  return `NSE:${u}`;
}

/** Epoch seconds for a `YYYY-MM-DD` expiry, or null. */
function expiryTimestamp(expiryDate) {
  if (!expiryDate) return null;
  const t = Math.floor(new Date(`${expiryDate}T15:30:00+05:30`).getTime() / 1000);
  return Number.isFinite(t) ? t : null;
}

/** Fyers reports expiry dates as DD-MM-YYYY. */
function toFyersDate(isoDate) {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split('-');
  return y && m && d ? `${d}-${m}-${y}` : null;
}

/**
 * Fyers rate-limits bursts; a short retry turns a transient failure into a miss.
 *
 * Only network errors and 5xx are worth retrying. A 429 is a limit and 401/403
 * are auth problems — retrying either just burns quota and, on Fyers, moves the
 * account closer to a same-day block.
 */
function retryable(e) {
  const status = Number(e?.status || 0);
  if (status === 429 || status === 401 || status === 403) return false;
  if (status >= 500) return true;
  return !status;
}

async function withRetry(fn, attempts = 3, delayMs = 700) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!retryable(e)) break;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

/** The chain changes far more slowly than we poll it. */
const CHAIN_TTL_MS = 30_000;
/**
 * How long a failed chain fetch is remembered. Every strategy currently shares
 * one underlying/expiry, so without this each of them fires its own request
 * into a broker that is already refusing us.
 */
const CHAIN_FAILURE_TTL_MS = 15_000;

const chainCache = new Map();     // key -> { value, until }
const chainInflight = new Map();  // key -> Promise
const chainFailures = new Map();  // key -> { error, until }

/**
 * Fetch an option chain once and share it.
 *
 * Single-flight, positively cached, and negatively cached on failure — so N
 * strategies polling every 2s cost one request per 30s instead of N per tick.
 */
async function chainCached(exchange, underlying, expiryDate) {
  const key = `resolver:chain:${exchange}:${underlying}:${expiryDate}`;
  const now = Date.now();

  const hit = chainCache.get(key);
  if (hit && now < hit.until) return hit.value;

  const failed = chainFailures.get(key);
  if (failed && now < failed.until) throw failed.error;

  const pending = chainInflight.get(key);
  if (pending) return pending;

  const attempt = getOptionChainAny(exchange, underlying, expiryDate)
    .then((chain) => {
      chainCache.set(key, { value: chain, until: Date.now() + CHAIN_TTL_MS });
      chainFailures.delete(key);
      return chain;
    })
    .catch((e) => {
      chainFailures.set(key, { error: e, until: Date.now() + CHAIN_FAILURE_TTL_MS });
      throw e;
    })
    .finally(() => chainInflight.delete(key));

  chainInflight.set(key, attempt);
  return attempt;
}

/**
 * Fyers-backed option chain, normalised to the same shape the resolver has
 * always returned: `{ underlying_ltp, strikes: { <strike>: { CE: {...}, PE: {...} } } }`.
 *
 * Needed because the Groww key expires daily and leaves the bot with no data.
 *
 * Fyers only accepts an expiry `timestamp` that appears in its own `expiryData`,
 * so the requested date is matched against that list rather than computed —
 * guessing an epoch (e.g. "next Thursday") produces "Please provide valid expiry".
 * The first (nearest-expiry) response already carries `expiryData`, so a second
 * call is only made when a different expiry was actually requested.
 */
export async function getOptionChainFyers(exchange, underlying, expiryDate) {
  const symbol = fyersUnderlying(underlying);
  const first = await withRetry(() => fyers.optionChain(symbol, { strikecount: 40 }));
  if (!first?.optionsChain?.length) {
    throw new Error(`Fyers returned an empty option chain for ${symbol}`);
  }

  let data = first;
  const want = toFyersDate(expiryDate);
  const nearest = first.expiryData?.[0]?.date;
  if (want && want !== nearest) {
    const match = (first.expiryData || []).find((e) => e.date === want);
    if (match?.expiry) {
      data = await withRetry(() => fyers.optionChain(symbol, { strikecount: 40, timestamp: match.expiry }));
    }
  }

  const legs = data?.optionsChain || [];
  if (!legs.length) throw new Error(`Fyers returned an empty option chain for ${symbol}`);

  const spot = legs.find((l) => l.option_type === '' || l.strike_price === -1);
  const strikes = {};
  for (const leg of legs) {
    if (!leg.option_type) continue;
    const s = Number(leg.strike_price);
    if (!Number.isFinite(s)) continue;
    (strikes[s] ||= {})[leg.option_type] = {
      trading_symbol: leg.symbol,
      ltp: Number(leg.ltp ?? 0),
      bid: Number(leg.bid ?? 0),
      ask: Number(leg.ask ?? 0),
    };
  }

  return {
    underlying_ltp: Number(spot?.ltp ?? 0),
    underlying_symbol: spot?.symbol ?? symbol,
    strikes,
    source: 'fyers',
  };
}

/** Pick whichever chain source is alive — Fyers first, Groww as fallback. */
export async function getOptionChainAny(exchange, underlying, expiryDate) {
  let fyersError = null;
  try {
    // When Fyers is rate-limiting us, do not even send the request.
    if (fyersBreakerStatus().open) {
      throw new FyersCircuitError('Fyers circuit open — skipping straight to Groww');
    }
    return await getOptionChainFyers(exchange, underlying, expiryDate);
  } catch (e) {
    fyersError = e.message;
  }
  // Groww is held back when its credential is known-broken, so a dead broker
  // does not add a round trip to every Fyers miss.
  if (growwHeldBack()) {
    throw new Error(`Fyers: ${fyersError} | Groww: held back (${growwHoldbackReason()})`);
  }
  try {
    return { ...(await getOptionChain(exchange, underlying, expiryDate)), source: 'groww' };
  } catch (growwErr) {
    // Report both: the Fyers failure is the interesting one, Groww's 401 is
    // expected while its key is expired.
    throw new Error(`Fyers: ${fyersError} | Groww: ${growwErr.message}`);
  }
}

/** Sentinel so callers can tell "skipped Fyers" apart from "Fyers failed". */
class FyersCircuitError extends Error {}

/**
 * Resolves a strategy's `instrument` block into a concrete tradable symbol.
 *
 * Two modes:
 *   { symbol: "NIFTY26O1922700PE" }   — used verbatim, no lookup
 *   { underlying: "NIFTY", optionType: "CE", strikeOffset: 0, expiry: "weekly" }
 *                                      — ATM (or nearest offset) at that expiry
 */

export function formatExpiry(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** NSE weekly F&O expiry is Thursday. */
export function weeklyExpiry(from = new Date()) {
  const d = new Date(from.getTime());
  d.setHours(0, 0, 0, 0);
  const minutesNow = from.getHours() * 60 + from.getMinutes();
  if (d.getDay() === 4 && minutesNow < 15 * 60) return formatExpiry(d);
  let add = (4 - d.getDay() + 7) % 7;
  if (add === 0) add = 7;
  d.setDate(d.getDate() + add);
  return formatExpiry(d);
}

/** Monthly expiry: the last Thursday of the month. */
export function monthlyExpiry(from = new Date()) {
  const findLastThursday = (year, month) => {
    const d = new Date(year, month + 1, 0);
    while (d.getDay() !== 4) d.setDate(d.getDate() - 1);
    return d;
  };
  const y = from.getFullYear();
  const m = from.getMonth();
  let d = findLastThursday(y, m);
  if (d.getTime() < new Date(y, m, 1).getTime() || d <= from) {
    d = findLastThursday(y, m + 1);
  }
  return formatExpiry(d);
}

function resolveExpiryDate(spec) {
  if (!spec) return weeklyExpiry();
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) return spec;
  if (spec === 'monthly') return monthlyExpiry();
  return weeklyExpiry();
}

export async function getOptionChain(exchange, underlying, expiryDate) {
  const res = await request(`/option-chain/exchange/${exchange}/underlying/${underlying}`, {
    query: { expiry_date: expiryDate },
  });
  return res?.payload ?? res;
}

/** Infer the strike step from the chain rather than hardcoding it. */
function strikeStep(strikes) {
  if (strikes.length < 2) return 50;
  const diffs = [];
  for (let i = 1; i < strikes.length; i += 1) diffs.push(strikes[i] - strikes[i - 1]);
  diffs.sort((a, b) => a - b);
  return diffs[0] || 50;
}

/**
 * Pick the target strike: ATM (or offset by whole steps) to the nearest
 * listed strike. Returns null if the chain has no usable strikes.
 */
function pickStrike(strikes, underlyingLtp, offset, step) {
  if (!strikes.length) return null;
  const target = underlyingLtp + (offset || 0) * step;
  let best = strikes[0];
  let bestDist = Math.abs(target - best);
  for (const s of strikes) {
    const d = Math.abs(target - s);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

export async function resolveInstrument(instrument) {
  if (instrument.symbol) {
    return {
      symbol: instrument.symbol,
      exchange: instrument.exchange || 'NSE',
      segment: instrument.segment || 'FNO',
      expiry: instrument.expiry || null,
      underlyingLtp: null,
      resolved: 'explicit',
    };
  }

  const exchange = instrument.exchange || 'NSE';
  const expiry = resolveExpiryDate(instrument.expiry);
  const chain = await chainCached(exchange, instrument.underlying, expiry);
  const underlyingLtp = Number(chain?.underlying_ltp ?? 0);
  const strikes = Object.keys(chain?.strikes || {}).map(Number).sort((a, b) => a - b);
  const step = strikeStep(strikes);
  const strike = pickStrike(strikes, underlyingLtp, Number(instrument.strikeOffset ?? 0), step);
  const contract = strike != null ? chain.strikes[String(strike)]?.[instrument.optionType] : null;

  if (!contract?.trading_symbol) {
    const available = strikes.length ? `${strikes.length} strikes` : 'no strikes';
    throw new Error(
      `Could not resolve ${instrument.optionType || 'CE'} ATM for ${instrument.underlying} @ ${expiry} ` +
        `(${available} in chain). Set "symbol" explicitly in the strategy to bypass this.`,
    );
  }

  return {
    symbol: contract.trading_symbol,
    // Quote routing: Fyers legs carry a native NSE:... symbol, Groww carries a
    // trading_symbol that only Groww's quote endpoint understands.
    quoteSymbol: chain.source === 'fyers' ? contract.trading_symbol : null,
    exchange,
    segment: instrument.segment || 'FNO',
    expiry,
    underlyingLtp,
    strike,
    optionType: instrument.optionType,
    ltp: Number(contract.ltp ?? 0),
    resolved: 'atm',
    source: chain.source,
  };
}

export function describeInstrument(r) {
  if (r.resolved === 'explicit') return r.symbol;
  return `${r.symbol}  (ATM ${r.strike} ${r.optionType} @ ${r.expiry})`;
}
