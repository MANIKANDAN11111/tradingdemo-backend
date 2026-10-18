/**
 * In-memory candle aggregator.
 *
 * The Groww endpoints we use expose LTP / quote / OHLC but not a reliable
 * intraday candle history, so the engine builds its own: every poll feeds a
 * tick in, and ticks are bucketed into candles of the requested interval.
 *
 * State is per-process and resets on restart. That is acceptable because the
 * engine only ever evaluates the current session.
 */

const books = new Map(); // `${key}@${intervalMs}` -> { key, intervalMs, candles }

const MAX_CANDLES = 500; // ~2 sessions of 1-minute candles

function bookFor(key, intervalMs) {
  const id = `${key}@${intervalMs}`;
  let book = books.get(id);
  if (!book) {
    book = { key, intervalMs, candles: [] };
    books.set(id, book);
  }
  return book;
}

/**
 * Feed one tick. Returns the (possibly updated) candle list.
 * `time` is epoch ms; `volume` is the incremental volume for this tick if known.
 */
export function feed(key, { price, volume = 0, time = Date.now() }, intervalMs) {
  const book = bookFor(key, intervalMs);
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return book.candles;

  const bucket = Math.floor(time / intervalMs) * intervalMs;
  const last = book.candles[book.candles.length - 1];

  if (last && last.time === bucket) {
    last.high = Math.max(last.high, p);
    last.low = Math.min(last.low, p);
    last.close = p;
    last.volume += Number(volume) || 0;
  } else {
    book.candles.push({
      time: bucket,
      open: p,
      high: p,
      low: p,
      close: p,
      volume: Number(volume) || 0,
    });
    if (book.candles.length > MAX_CANDLES) book.candles.shift();
  }
  return book.candles;
}

export function getCandles(key, intervalMs) {
  return bookFor(key, intervalMs).candles;
}

/** Drop candles that belong to a session that has already ended. */
export function resetSession(key, intervalMs) {
  const book = bookFor(key, intervalMs);
  book.candles = [];
}

export function resetAll() {
  books.clear();
}

export function bookStats() {
  return [...books.values()].map((b) => ({ key: b.key, intervalMs: b.intervalMs, candles: b.candles.length }));
}
