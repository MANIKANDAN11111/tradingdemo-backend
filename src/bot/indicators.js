/**
 * Indicator maths. Pure functions over plain arrays — no dependencies, easy to
 * unit-test, and safe to call from the strategy evaluator on every tick.
 *
 * A candle is { time, open, high, low, close, volume }.
 */

export function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

export function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function trueRange(prevClose, c) {
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
}

export function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i += 1) {
    trs.push(trueRange(candles[i - 1].close, candles[i]));
  }
  return sma(trs, period);
}

export function vwap(candles) {
  if (!Array.isArray(candles) || !candles.length) return null;
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    const v = Number(c.volume) || 0;
    pv += typical * v;
    vol += v;
  }
  if (vol === 0) {
    // No volume data — fall back to the mean typical price.
    const sum = candles.reduce((a, c) => a + (c.high + c.low + c.close) / 3, 0);
    return sum / candles.length;
  }
  return pv / vol;
}

export function highest(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  return Math.max(...values.slice(-period));
}

export function lowest(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  return Math.min(...values.slice(-period));
}

/**
 * Opening Range Breakout levels: the high/low of the first `minutes` of the
 * session. Returns null until the range has actually formed.
 */
export function openingRange(candles, minutes = 15) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const start = candles[0].time;
  const cutoff = start + minutes * 60_000;
  const window = candles.filter((c) => c.time <= cutoff);
  if (!window.length) return null;
  return {
    high: Math.max(...window.map((c) => c.high)),
    low: Math.min(...window.map((c) => c.low)),
    formedAt: cutoff,
    complete: candles[candles.length - 1].time > cutoff,
  };
}

/**
 * Liquidity sweep: price pierces a recent swing high/low by at least
 * `bufferPoints` then closes back inside within `maxCandles`.
 * Returns { side: 'buy'|'sell', level, sweptCandle } or null.
 */
export function sweep(candles, { bufferPoints = 3, maxCandles = 3, lookback = 20 } = {}) {
  if (!Array.isArray(candles) || candles.length < 5) return null;
  const n = candles.length;
  const recent = candles.slice(-lookback - 1, -1);
  if (recent.length < 3) return null;

  const last = candles[n - 1];
  const pivotHigh = Math.max(...recent.map((c) => c.high));
  const pivotLow = Math.min(...recent.map((c) => c.low));

  // Sell-side sweep: price went above pivotHigh + buffer, now closing back below
  if (last.high > pivotHigh + bufferPoints && last.close < pivotHigh) {
    return { side: 'sell', level: pivotHigh, sweptCandle: n - 1 };
  }
  // Buy-side sweep: price went below pivotLow - buffer, now closing back above
  if (last.low < pivotLow - bufferPoints && last.close > pivotLow) {
    return { side: 'buy', level: pivotLow, sweptCandle: n - 1 };
  }
  return null;
}

/**
 * Break of Structure / Change of Character.
 * A BOS confirms the current trend; a CHoCH is the first reversal after a
 * swing. Returns { type: 'bos_up'|'bos_down'|'choch_up'|'choch_down', level }
 * or null.
 */
export function bosCHoCH(candles, lookback = 10) {
  if (!Array.isArray(candles) || candles.length < lookback + 2) return null;
  const n = candles.length;
  const last = candles[n - 1];
  const prev = candles[n - 2];

  // Find recent swing high/low
  const highs = candles.slice(-lookback - 1, -1).map((c) => c.high);
  const lows = candles.slice(-lookback - 1, -1).map((c) => c.low);
  const swingHigh = Math.max(...highs);
  const swingLow = Math.min(...lows);

  // Bullish BOS: close above prior swing high
  if (last.close > swingHigh && prev.close <= swingHigh) {
    return { type: 'bos_up', level: swingHigh };
  }
  // Bearish BOS: close below prior swing low
  if (last.close < swingLow && prev.close >= swingLow) {
    return { type: 'bos_down', level: swingLow };
  }
  // Bullish CHoCH: price was making lower lows, now closes above prior candle's high
  if (prev.low < swingLow && last.close > prev.high) {
    return { type: 'choch_up', level: prev.high };
  }
  // Bearish CHoCH: price was making higher highs, now closes below prior candle's low
  if (prev.high > swingHigh && last.close < prev.low) {
    return { type: 'choch_down', level: prev.low };
  }
  return null;
}

/**
 * Displacement: a candle whose body and range are unusually large compared
 * to the recent average, with a directional close in the top/bottom third.
 * Returns { direction: 'bullish'|'bearish', ratio } or null.
 */
export function displacement(candles, lookback = 20, minRatio = 1.5) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return null;
  const n = candles.length;
  const last = candles[n - 1];
  const prior = candles.slice(-lookback - 1, -1);
  if (prior.length < 5) return null;

  const avgRange = prior.reduce((a, c) => a + (c.high - c.low), 0) / prior.length;
  const range = last.high - last.low;
  if (avgRange <= 0 || range / avgRange < minRatio) return null;

  const body = Math.abs(last.close - last.open);
  const closePos = (last.close - last.low) / range;
  if (last.close > last.open && closePos >= 0.6) return { direction: 'bullish', ratio: range / avgRange };
  if (last.close < last.open && closePos <= 0.4) return { direction: 'bearish', ratio: range / avgRange };
  return null;
}

/**
 * Fair Value Gap: a 3-candle imbalance where the middle candle's range is
 * completely bypassed by the outer candles. Returns { type: 'bullish'|'bearish',
 * top, bottom } or null.
 */
export function fvg(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return null;
  const n = candles.length;
  const c1 = candles[n - 3];
  const c2 = candles[n - 2];
  const c3 = candles[n - 1];

  // Bullish FVG: c1.high < c3.low (gap between c1 top and c3 bottom)
  if (c1.high < c3.low) {
    return { type: 'bullish', top: c3.low, bottom: c1.high, mid: (c1.high + c3.low) / 2 };
  }
  // Bearish FVG: c1.low > c3.high
  if (c1.low > c3.high) {
    return { type: 'bearish', top: c1.low, bottom: c3.high, mid: (c1.low + c3.high) / 2 };
  }
  return null;
}

/**
 * Order block: the last bearish candle before a strong bullish move (bullish
 * OB), or the last bullish candle before a strong bearish move (bearish OB).
 * Returns { type: 'bullish'|'bearish', high, low, index } or null.
 */
export function orderBlock(candles, lookback = 10) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return null;
  const n = candles.length;
  const last = candles[n - 1];

  // Bullish OB: last candle is bearish, preceded by a strong bullish candle
  if (last.close < last.open) {
    const prev = candles[n - 2];
    if (prev.close > prev.open && (prev.close - prev.open) > (prev.high - prev.low) * 0.5) {
      return { type: 'bullish', high: last.high, low: last.low, index: n - 1 };
    }
  }
  // Bearish OB: last candle is bullish, preceded by a strong bearish candle
  if (last.close > last.open) {
    const prev = candles[n - 2];
    if (prev.close < prev.open && (prev.open - prev.close) > (prev.high - prev.low) * 0.5) {
      return { type: 'bearish', high: last.high, low: last.low, index: n - 1 };
    }
  }
  return null;
}

/**
 * Relative Volume: current volume vs the average of the prior `period` candles.
 * Returns a ratio (>= 0) or null when there is no volume data.
 */
export function rvol(candles, period = 20) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const last = candles[candles.length - 1];
  const prior = candles.slice(-period - 1, -1);
  const avgVol = prior.reduce((a, c) => a + (Number(c.volume) || 0), 0) / period;
  if (avgVol <= 0) return null;
  return Number(last.volume) / avgVol;
}

/**
 * Central Pivot Range: classic CPR formula.
 * Returns { cp, tc, bc, width } or null.
 */
export function cpr(candles) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const last = candles[candles.length - 1];
  const { high, low, close } = last;
  if (!high || !low || !close) return null;
  const pivot = (high + low + close) / 3;
  const bc = (high + low) / 2;
  const tc = (pivot - bc) + pivot;
  return { cp: pivot, tc, bc, width: tc - bc };
}

/**
 * Aggregate 1-minute candles into a higher timeframe.
 * candles: 1m candles. targetMs: e.g. 5*60_000 for 5m, 15*60_000 for 15m.
 */
export function aggregate(candles, targetMs) {
  if (!Array.isArray(candles) || !candles.length) return [];
  const out = [];
  let bucket = null;
  let bucketStart = null;
  for (const c of candles) {
    const b = Math.floor(c.time / targetMs) * targetMs;
    if (b !== bucketStart) {
      if (bucket) out.push(bucket);
      bucketStart = b;
      bucket = { time: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: Number(c.volume) || 0 };
    } else {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume += Number(c.volume) || 0;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

/* ======================================================================== *
 * Structural analysis
 *
 * The functions above are rolling-window heuristics. The ones below work on
 * actual swing structure, which is what the BALA A+ strategy is written
 * against: liquidity sweeps, breaks of structure, fair value gaps and order
 * blocks are all defined relative to confirmed swing points, not to a
 * rolling max/min.
 * ======================================================================== */

/**
 * Confirmed swing highs/lows: a pivot that is strictly the extreme of its
 * left/right neighbourhood. Returns indices, oldest first.
 */
export function swingPoints(candles, left = 2, right = 2) {
  const highs = [];
  const lows = [];
  if (!Array.isArray(candles)) return { highs, lows };
  for (let i = left; i < candles.length - right; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j += 1) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}

/**
 * Liquidity sweep on swing structure: price pierces a confirmed swing level
 * and then closes back inside it. That is the stop-run / rejection the
 * strategy calls a sweep.
 *
 * Returns { side: 'sell'|'buy', level, swingIndex } or null.
 *   'sell' → buy-side liquidity taken above a swing high (bearish read)
 *   'buy'  → sell-side liquidity taken below a swing low  (bullish read)
 */
export function structuralSweep(candles, { left = 3, right = 3 } = {}) {
  if (!Array.isArray(candles) || candles.length < left + right + 3) return null;
  const { highs, lows } = swingPoints(candles, left, right);
  const last = candles[candles.length - 1];

  const sweptHigh = highs
    .map((i) => ({ index: i, level: candles[i].high }))
    .reverse()
    .find((s) => {
      const after = candles.slice(s.index + 1);
      return after.some((c) => c.high > s.level) && last.close < s.level;
    });

  const sweptLow = lows
    .map((i) => ({ index: i, level: candles[i].low }))
    .reverse()
    .find((s) => {
      const after = candles.slice(s.index + 1);
      return after.some((c) => c.low < s.level) && last.close > s.level;
    });

  if (sweptHigh) return { side: 'sell', level: sweptHigh.level, swingIndex: sweptHigh.index };
  if (sweptLow) return { side: 'buy', level: sweptLow.level, swingIndex: sweptLow.index };
  return null;
}

/**
 * Break of structure / change of character against real swing structure.
 *
 * BOS  — the latest close breaks a swing level in the direction the market
 *        was already heading.
 * CHoCH— the latest close breaks a swing level *against* the most recent
 *        swing sequence, i.e. character has changed.
 *
 * Returns { type: 'bos_up'|'bos_down'|'choch_up'|'choch_down', level, swingIndex } or null.
 */
export function structureBreak(candles, { left = 3, right = 3 } = {}) {
  if (!Array.isArray(candles) || candles.length < left + right + 3) return null;
  const { highs, lows } = swingPoints(candles, left, right);
  const last = candles[candles.length - 1];
  const lastHigh = highs.length ? highs[highs.length - 1] : null;
  const lastLow = lows.length ? lows[lows.length - 1] : null;

  const brokeHigh = lastHigh != null && last.close > candles[lastHigh].high;
  const brokeLow = lastLow != null && last.close < candles[lastLow].low;

  if (!brokeHigh && !brokeLow) return null;

  // Most recent swing dictates whether this is continuation or reversal.
  const recentHighFirst = lastHigh != null && (lastLow == null || lastHigh > lastLow);
  if (brokeHigh) {
    const type = recentHighFirst ? 'bos_up' : 'choch_up';
    return { type, level: candles[lastHigh].high, swingIndex: lastHigh };
  }
  const type = recentHighFirst ? 'choch_down' : 'bos_down';
  return { type, level: candles[lastLow].low, swingIndex: lastLow };
}

/** The most recent fair value gap in the candle series, if any. */
export function latestFVG(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return null;
  for (let i = candles.length - 2; i >= 1; i -= 1) {
    const a = candles[i - 1];
    const b = candles[i + 1];
    if (a.high < b.low) return { type: 'bullish', top: b.low, bottom: a.high, index: i };
    if (a.low > b.high) return { type: 'bearish', top: a.low, bottom: b.high, index: i };
  }
  return null;
}

/** Has the latest candle traded back into an FVG zone? */
export function fvgRetest(candles, gap) {
  if (!gap || !Array.isArray(candles) || !candles.length) return false;
  const last = candles[candles.length - 1];
  return last.low <= gap.top && last.high >= gap.bottom;
}

/**
 * Order block for a given structure break: the last candle that moved against
 * the break, immediately before it. Returns { type, high, low, index } or null.
 */
export function orderBlockFor(candles, structure) {
  if (!structure || structure.swingIndex == null) return null;
  const from = Math.min(structure.swingIndex, candles.length - 1);
  for (let i = from; i >= 1; i -= 1) {
    const c = candles[i];
    if (structure.type.includes('up') && c.close < c.open) {
      return { type: 'bullish', high: c.high, low: c.low, index: i };
    }
    if (structure.type.includes('down') && c.close > c.open) {
      return { type: 'bearish', high: c.high, low: c.low, index: i };
    }
  }
  return null;
}

/**
 * A breaker is a *failed* order block: demand that price closed back through
 * (bullish OB → bearish breaker), or supply that price closed back through
 * (bearish OB → bullish breaker).
 */
export function isBreaker(candles, ob) {
  if (!ob) return false;
  return candles.slice(ob.index + 1).some((c) =>
    ob.type === 'bullish' ? c.low < ob.low : c.high > ob.high,
  );
}

/** Keltner channel: EMA ± mult × ATR. */
export function keltner(candles, period = 20, mult = 2) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const mid = ema(candles.map((c) => c.close), period);
  const a = atr(candles, period);
  if (mid == null || a == null) return null;
  return { mid, upper: mid + mult * a, lower: mid - mult * a, atr: a };
}

/**
 * Previous session's high/low/close from a daily candle series — the input
 * the CPR needs. Returns null until at least two sessions exist.
 */
export function priorSession(dailyCandles) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length < 2) return null;
  const prev = dailyCandles[dailyCandles.length - 2];
  return { high: prev.high, low: prev.low, close: prev.close };
}

/**
 * CPR from explicit prior-session values (the correct input) rather than
 * from the current candle, which the rolling helper above has to use.
 */
export function cprFrom(prevHigh, prevLow, prevClose) {
  // `Number(null)` is 0 and `Number('')` is 0, both finite — so reject absent
  // values explicitly rather than letting them masquerade as a real price.
  const present = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  if (![prevHigh, prevLow, prevClose].every(present)) return null;
  const h = Number(prevHigh);
  const l = Number(prevLow);
  const c = Number(prevClose);
  const pivot = (h + l + c) / 3;
  const bc = (h + l) / 2;
  const tc = 2 * pivot - bc;
  return { cp: pivot, tc, bc, width: tc - bc, r1: 2 * pivot - l, s1: 2 * pivot - h };
}

/**
 * Fixed-range volume profile.
 *
 * This is a genuine volume-at-price distribution, but derived from OHLCV
 * candles rather than from an exchange volume-profile feed: each candle's
 * volume is spread evenly across the price bins its high-low range covers.
 * That is the standard approximation when only candles are available, and it
 * is labelled as derived in the UI so it is never mistaken for a native
 * volume-profile feed.
 *
 * Returns { poc, vah, val, bins } or null when there is no volume data.
 */
export function volumeProfile(candles, binCount = 24, valueAreaPct = 0.7) {
  if (!Array.isArray(candles) || candles.length < 5) return null;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  if (!(hi > lo)) return null;

  const totalVol = candles.reduce((a, c) => a + (Number(c.volume) || 0), 0);
  if (totalVol <= 0) return null;

  const size = (hi - lo) / binCount;
  const bins = Array.from({ length: binCount }, (_, i) => ({ price: lo + size * (i + 0.5), volume: 0 }));

  for (const c of candles) {
    const vol = Number(c.volume) || 0;
    if (vol <= 0) continue;
    const from = Math.max(0, Math.floor((c.low - lo) / size));
    const to = Math.min(binCount - 1, Math.floor((c.high - lo) / size));
    const span = to - from + 1;
    for (let b = from; b <= to; b += 1) bins[b].volume += vol / span;
  }

  const pocIdx = bins.reduce((best, b, i) => (b.volume > bins[best].volume ? i : best), 0);
  const poc = bins[pocIdx].price;

  // Grow the value area outward from the POC until it holds valueAreaPct.
  const target = totalVol * valueAreaPct;
  let acc = bins[pocIdx].volume;
  let up = pocIdx;
  let down = pocIdx;
  while (acc < target && (up < binCount - 1 || down > 0)) {
    const upVol = up < binCount - 1 ? bins[up + 1].volume : -1;
    const downVol = down > 0 ? bins[down - 1].volume : -1;
    if (upVol >= downVol && up < binCount - 1) { up += 1; acc += upVol; }
    else if (down > 0) { down -= 1; acc += downVol; }
    else break;
  }

  return { poc, vah: bins[up].price, val: bins[down].price, bins };
}

/** Where is price relative to the volume profile's value area? */
export function profileContext(price, profile) {
  if (!profile) return null;
  if (price > profile.vah) return 'above-value';
  if (price < profile.val) return 'below-value';
  return 'in-value';
}

/* ------------------------------------------------------- lookback scans --- */

/**
 * The most recent break of structure within the last `lookback` candles.
 *
 * A BALA setup runs sweep → BOS → retest → trigger, so the break of structure
 * is typically several candles behind the entry. Checking only the final
 * candle would miss almost every valid setup.
 *
 * Swing indices are reported against the full series, so they can be handed
 * straight to orderBlockFor().
 */
export function recentStructureBreak(candles, { left = 2, right = 2, lookback = 1 } = {}) {
  const minLen = left + right + 2;
  if (!Array.isArray(candles) || candles.length < minLen) return null;

  const from = Math.max(minLen - 1, candles.length - lookback);
  for (let j = candles.length - 1; j >= from; j -= 1) {
    const prior = candles.slice(0, j);            // structure as it stood before candle j
    const { highs, lows } = swingPoints(prior, left, right);
    const lastHigh = highs.length ? highs[highs.length - 1] : null;
    const lastLow = lows.length ? lows[lows.length - 1] : null;
    const c = candles[j];

    const brokeHigh = lastHigh != null && c.close > prior[lastHigh].high;
    const brokeLow = lastLow != null && c.close < prior[lastLow].low;
    if (!brokeHigh && !brokeLow) continue;

    // Whichever swing is more recent decides continuation vs reversal.
    const highIsMoreRecent = lastHigh != null && (lastLow == null || lastHigh > lastLow);
    if (brokeHigh) {
      return {
        type: highIsMoreRecent ? 'bos_up' : 'choch_up',
        level: prior[lastHigh].high,
        swingIndex: lastHigh,
        candleIndex: j,
      };
    }
    return {
      type: highIsMoreRecent ? 'choch_down' : 'bos_down',
      level: prior[lastLow].low,
      swingIndex: lastLow,
      candleIndex: j,
    };
  }
  return null;
}

/** The most recent displacement candle within the last `lookback` candles. */
export function recentDisplacement(candles, { period = 20, minRangeMult = 1.5, lookback = 1 } = {}) {
  if (!Array.isArray(candles) || candles.length < period + 2) return null;
  const from = Math.max(period + 1, candles.length - lookback);
  for (let j = candles.length - 1; j >= from; j -= 1) {
    const window = candles.slice(0, j + 1);
    const d = displacement(window, period, minRangeMult);
    if (d) return { ...d, candleIndex: j };
  }
  return null;
}
