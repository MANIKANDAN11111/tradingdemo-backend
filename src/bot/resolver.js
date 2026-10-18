import { request } from '../growwClient.js';

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
  const chain = await getOptionChain(exchange, instrument.underlying, expiry);
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
    exchange,
    segment: instrument.segment || 'FNO',
    expiry,
    underlyingLtp,
    strike,
    optionType: instrument.optionType,
    ltp: Number(contract.ltp ?? 0),
    resolved: 'atm',
  };
}

export function describeInstrument(r) {
  if (r.resolved === 'explicit') return r.symbol;
  return `${r.symbol}  (ATM ${r.strike} ${r.optionType} @ ${r.expiry})`;
}
