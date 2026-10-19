import { Router } from 'express';
import { fyers } from '../fyersClient.js';
import { groww } from '../growwClient.js';
import { cached } from '../cache.js';

const router = Router();

// Fyers Data API is capped at 50 req/min. One call every 5 minutes = 12 req/min,
// well within budget even with Groww fallback.
const FYERS_TTL = 5 * 60_000; // 5 minutes
const TTL = 2_000; // sub-endpoint cache for /ltp, /quote, /ohlc

/**
 * Fyers symbol format: NSE:NIFTY50-INDEX, BSE:SENSEX-INDEX, etc.
 * Groww fallback uses: NSE_NIFTY, BSE_SENSEX, etc.
 */
export const INDICES = [
  { key: 'NSE_NIFTY', label: 'NIFTY', fyers: 'NSE:NIFTY50-INDEX', exchange: 'NSE', symbol: 'NIFTY' },
  { key: 'BSE_SENSEX', label: 'SENSEX', fyers: 'BSE:SENSEX-INDEX', exchange: 'BSE', symbol: 'SENSEX' },
  { key: 'NSE_BANKNIFTY', label: 'BANKNIFTY', fyers: 'NSE:NIFTYBANK-INDEX', exchange: 'NSE', symbol: 'BANKNIFTY' },
  { key: 'NSE_FINNIFTY', label: 'FINNIFTY', fyers: 'NSE:FINNIFTY-INDEX', exchange: 'NSE', symbol: 'FINNIFTY' },
  { key: 'NSE_MIDCPNIFTY', label: 'MIDCPNIFTY', fyers: 'NSE:MIDCPNIFTY-INDEX', exchange: 'NSE', symbol: 'MIDCPNIFTY' },
];

function parseSymbols(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Fetch index quotes from Fyers. Falls back to Groww if Fyers is not
 * authenticated or returns an error.
 *
 * Fyers quote response shape: { v: { lp, prev_close_price, open_price, ... } }
 */
async function getIndicesFromFyers() {
  const symbols = INDICES.map((i) => i.fyers);
  const raw = await fyers.quotes(symbols);

  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Fyers returned empty quotes array');
  }

  return INDICES.map((idx, i) => {
    const q = raw[i]?.v ?? raw[i] ?? {};
    const ltp = Number(q.lp ?? q.lastPrice ?? q.ltp ?? 0) || null;
    const prevClose = Number(q.prev_close_price ?? q.prevClose ?? 0) || null;
    const change = ltp != null && prevClose != null ? ltp - prevClose : null;
    const changePct = change != null && prevClose ? (change / prevClose) * 100 : null;

    return {
      key: idx.key,
      label: idx.label,
      ltp,
      change,
      changePct,
      direction: changePct == null ? null : changePct >= 0 ? 'up' : 'down',
      source: 'fyers',
    };
  });
}

/** Groww fallback — same shape as Fyers result. */
async function getIndicesFromGroww() {
  const keys = INDICES.map((i) => i.key);

  const ltpMap = await cached(`ltp:${keys.join(',')}`, TTL, () => groww.ltp(keys)).catch(() => ({}));

  const quotes = await Promise.all(
    INDICES.map((idx) =>
      cached(`quote:${idx.exchange}:${idx.symbol}`, TTL, () =>
        groww.quote({ exchange: idx.exchange, segment: 'CASH', tradingSymbol: idx.symbol })
      ).catch(() => null)
    )
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
      source: 'groww',
    };
  });
}

/**
 * Get indices with LTP plus day change. Tries Fyers first, falls back to Groww.
 * Cached for 5 minutes to respect Fyers' 50 req/min rate limit.
 */
export async function getIndices() {
  return cached('indices:all', FYERS_TTL, async () => {
    try {
      return await getIndicesFromFyers();
    } catch (fyersErr) {
      console.log(`[market] Fyers unavailable (${fyersErr.message}), falling back to Groww`);
      return getIndicesFromGroww();
    }
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
    const raw = await cached(`quote:${exchange}:${symbol}`, TTL, () =>
      groww.quote({ exchange, segment, tradingSymbol: symbol })
    );
    res.json({ ok: true, quote: raw });
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
