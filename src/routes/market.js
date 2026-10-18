import { Router } from 'express';
import { groww } from '../growwClient.js';
import { cached } from '../cache.js';
import { deepCamel } from '../util/case.js';

const router = Router();
// Live Data (quote / LTP / OHLC) is capped at 300 req/min upstream.
// getIndices() makes 6 such calls, so a 2s cache keeps a 3s UI refresh
// around 120 req/min — well inside the limit, even with several tabs open.
const TTL = 2_000;

/** Verified against the live API: LTP keys use the EXCHANGE_SYMBOL form. */
export const INDICES = [
  { key: 'NSE_NIFTY', label: 'NIFTY', exchange: 'NSE', symbol: 'NIFTY' },
  { key: 'BSE_SENSEX', label: 'SENSEX', exchange: 'BSE', symbol: 'SENSEX' },
  { key: 'NSE_BANKNIFTY', label: 'BANKNIFTY', exchange: 'NSE', symbol: 'BANKNIFTY' },
  { key: 'NSE_FINNIFTY', label: 'FINNIFTY', exchange: 'NSE', symbol: 'FINNIFTY' },
  { key: 'NSE_MIDCPNIFTY', label: 'MIDCPNIFTY', exchange: 'NSE', symbol: 'MIDCPNIFTY' },
];

function parseSymbols(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Quote for one symbol, normalised to camelCase. Cached. */
async function quoteFor(exchange, symbol, segment = 'CASH') {
  const raw = await cached(`quote:${exchange}:${symbol}`, TTL, () =>
    groww.quote({ exchange, segment, tradingSymbol: symbol })
  );
  return deepCamel(raw);
}

/** Indices with LTP plus day change. */
export async function getIndices() {
  const keys = INDICES.map((i) => i.key);

  // LTP map keys are exchange symbols — must NOT be camel-cased.
  const ltpMap = await cached(`ltp:${keys.join(',')}`, TTL, () => groww.ltp(keys)).catch(() => ({}));

  const quotes = await Promise.all(
    INDICES.map((idx) => quoteFor(idx.exchange, idx.symbol).catch(() => null))
  );

  return INDICES.map((idx, i) => {
    const q = quotes[i];
    const ltp = ltpMap?.[idx.key] ?? q?.lastPrice ?? q?.ohlc?.close ?? null;
    const change = q?.dayChange ?? null;
    const changePct = q?.dayChangePerc ?? null;
    return {
      key: idx.key,
      label: idx.label,
      ltp,
      change,
      changePct,
      direction: changePct == null ? null : changePct >= 0 ? 'up' : 'down',
    };
  });
}

router.get('/ltp', async (req, res, next) => {
  try {
    const symbols = parseSymbols(req.query.symbols);
    if (!symbols.length) {
      return res.status(400).json({ ok: false, error: 'symbols query param required, e.g. ?symbols=NSE_NIFTY,BSE_SENSEX' });
    }
    const segment = String(req.query.segment || 'CASH').toUpperCase();
    const ltp = await cached(`ltp:${symbols.join(',')}`, TTL, () => groww.ltp(symbols, segment));
    res.json({ ok: true, segment, ltp });
  } catch (err) {
    next(err);
  }
});

router.get('/quote', async (req, res, next) => {
  try {
    const { exchange = 'NSE', symbol, segment = 'CASH' } = req.query;
    if (!symbol) return res.status(400).json({ ok: false, error: 'symbol query param required' });
    const quote = await quoteFor(String(exchange).toUpperCase(), String(symbol).toUpperCase(), String(segment).toUpperCase());
    res.json({ ok: true, quote });
  } catch (err) {
    next(err);
  }
});

router.get('/ohlc', async (req, res, next) => {
  try {
    const symbols = parseSymbols(req.query.symbols);
    if (!symbols.length) return res.status(400).json({ ok: false, error: 'symbols query param required' });
    const segment = String(req.query.segment || 'CASH').toUpperCase();
    const ohlc = await cached(`ohlc:${symbols.join(',')}`, TTL, () => groww.ohlc(symbols, segment));
    res.json({ ok: true, segment, ohlc });
  } catch (err) {
    next(err);
  }
});

router.get('/indices', async (req, res, next) => {
  try {
    res.json({ ok: true, indices: await getIndices() });
  } catch (err) {
    next(err);
  }
});

export default router;
