import { ema, sma, rsi, vwap, atr, highest, lowest, openingRange } from './indicators.js';

/**
 * Build the indicator context a strategy condition can reference by name.
 * Every key here is usable as `"value"` or `"indicator"` in strategies.json.
 */
export function buildContext({ candles = [], ltp = null, prevClose = null, orbMinutes = 15 }) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const last = candles[candles.length - 1] || {};
  const orb = openingRange(candles, orbMinutes);

  return {
    ltp: ltp ?? last.close ?? null,
    open: last.open ?? null,
    high: last.high ?? null,
    low: last.low ?? null,
    close: last.close ?? null,
    prevClose: prevClose ?? null,
    dayHigh: highs.length ? Math.max(...highs) : null,
    dayLow: lows.length ? Math.min(...lows) : null,
    orbHigh: orb?.high ?? null,
    orbLow: orb?.low ?? null,
    orbComplete: orb?.complete ?? false,
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    ema50: ema(closes, 50),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    rsi14: rsi(closes, 14),
    vwap: vwap(candles),
    atr14: atr(candles, 14),
    highest20: highest(highs, 20),
    lowest20: lowest(lows, 20),
    candleCount: candles.length,
  };
}

/** A condition operand may be a number, a numeric string, or an indicator name. */
function resolve(token, ctx) {
  if (typeof token === 'number') return token;
  if (typeof token === 'string') {
    const asNumber = Number(token);
    if (token.trim() !== '' && !Number.isNaN(asNumber)) return asNumber;
    const v = ctx[token];
    return v === undefined ? null : v;
  }
  return null;
}

function compare(op, left, right) {
  switch (op) {
    case '>': return left > right;
    case '<': return left < right;
    case '>=': return left >= right;
    case '<=': return left <= right;
    case 'equals': return left === right;
    default: return false;
  }
}

/**
 * Evaluate one condition. Crosses need the previous tick's context, so pass it
 * when available; without it, a cross is treated as not-yet-triggered rather
 * than firing on the first tick.
 */
export function evaluateCondition(c, ctx, prevCtx) {
  const left = resolve(c.indicator, ctx);
  const right = resolve(c.value, ctx);
  if (left === null || right === null) return false;

  if (c.op === 'crossesAbove') {
    if (!prevCtx) return false;
    const pl = resolve(c.indicator, prevCtx);
    const pr = resolve(c.value, prevCtx);
    if (pl === null || pr === null) return false;
    return pl <= pr && left > right;
  }
  if (c.op === 'crossesBelow') {
    if (!prevCtx) return false;
    const pl = resolve(c.indicator, prevCtx);
    const pr = resolve(c.value, prevCtx);
    if (pl === null || pr === null) return false;
    return pl >= pr && left < right;
  }
  return compare(c.op, left, right);
}

export function evaluateAll(conditions, ctx, prevCtx) {
  if (!Array.isArray(conditions) || !conditions.length) return false;
  return conditions.every((c) => evaluateCondition(c, ctx, prevCtx));
}

/** Human-readable trace, so the UI can show why a strategy did or didn't fire. */
export function explain(conditions, ctx, prevCtx) {
  return (conditions || []).map((c) => ({
    expression: `${c.indicator} ${c.op} ${c.value}`,
    left: resolve(c.indicator, ctx),
    right: resolve(c.value, ctx),
    result: evaluateCondition(c, ctx, prevCtx),
  }));
}

/** Is `now` inside the strategy's entry window? Times are 'HH:MM' in IST. */
export function inWindow(window, now = new Date()) {
  if (!window?.from || !window?.to) return true;
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const parse = (t) => {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + (m || 0);
  };
  return minutes >= parse(window.from) && minutes <= parse(window.to);
}
