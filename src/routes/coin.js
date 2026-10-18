import { Router } from 'express';
import { coinswitch, coinSwitchPublicKey, CoinSwitchApiError } from '../coinSwitchClient.js';
import { cached } from '../cache.js';

const router = Router();
const EXCHANGE = 'coinswitchx';

/** Shape CoinSwitch's single-letter candle/trade keys into readable ones. */
const normalizeCandle = (c) => ({
  open: c.o, high: c.h, low: c.l, close: c.c, volume: c.volume,
  startTime: c.start_time, closeTime: c.close_time, symbol: c.symbol,
});
const normalizeTrade = (t) => ({
  time: t.E, price: t.p, quantity: t.q, symbol: t.s, id: t.t, exchange: t.e, isBuyerMaker: t.m,
});

/** A pair row, padded with the fields the UI needs. */
const pairRow = (raw) => ({
  symbol: raw.symbol,
  lastPrice: Number(raw.lastPrice) || 0,
  changePct: Number(raw.percentageChange) || 0,
  high: Number(raw.highPrice) || 0,
  low: Number(raw.lowPrice) || 0,
  open: Number(raw.openPrice) || 0,
  baseVolume: Number(raw.baseVolume) || 0,
  quoteVolume: Number(raw.quoteVolume) || 0,
  bid: Number(raw.bidPrice) || 0,
  ask: Number(raw.askPrice) || 0,
  updatedAt: raw.at ? new Date(raw.at).toISOString() : null,
});

router.get('/status', async (_req, res, next) => {
  try {
    const result = await coinswitch.validateKeys();
    res.json({ ok: true, valid: result?.message === 'Valid Access', apiKey: coinSwitchPublicKey(), raw: result });
  } catch (err) {
    next(err);
  }
});

router.get('/tickers', async (req, res, next) => {
  try {
    const { exchange = EXCHANGE, symbol } = req.query;
    if (symbol) {
      const body = await coinswitch.ticker(symbol, exchange);
      res.json({ ok: true, exchange, symbols: symbol.split(',').map(pairRow) });
      return;
    }
    const body = await coinswitch.allPairsTicker(exchange);
    const rows = Object.values(body?.data || {}).map(pairRow);
    rows.sort((a, b) => b.quoteVolume - a.quoteVolume);
    res.json({ ok: true, exchange, count: rows.length, pairs: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/depth', async (req, res, next) => {
  try {
    const { symbol = 'BTC/INR', exchange = EXCHANGE } = req.query;
    const body = await coinswitch.depth(symbol, exchange);
    const d = body?.data || {};
    res.json({
      ok: true,
      symbol,
      exchange,
      timestamp: d.timestamp ? new Date(d.timestamp).toISOString() : null,
      bids: (d.bids || []).slice(0, 8).map(([price, qty]) => ({ price: Number(price), quantity: Number(qty) })),
      asks: (d.asks || []).slice(0, 8).map(([price, qty]) => ({ price: Number(price), quantity: Number(qty) })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/candles', async (req, res, next) => {
  try {
    const { symbol = 'BTC/INR', exchange = EXCHANGE, interval = '60', hours = '24' } = req.query;
    const end = Date.now();
    const start = end - Number(hours) * 3600_000;
    const body = await coinswitch.candles(symbol, interval, start, end, exchange);
    res.json({ ok: true, symbol, exchange, interval: Number(interval), candles: (body?.data || []).map(normalizeCandle) });
  } catch (err) {
    next(err);
  }
});

router.get('/trades', async (req, res, next) => {
  try {
    const { symbol = 'BTC/INR', exchange = EXCHANGE, limit = '15' } = req.query;
    const body = await coinswitch.trades(symbol, exchange);
    const rows = (body?.data || []).slice(0, Number(limit)).map(normalizeTrade);
    res.json({ ok: true, symbol, exchange, trades: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * Aggregate for the crypto panel: key status, the top pairs by 24h turnover,
 * and a default symbol's order book + recent trades.
 * CoinSwitch rate limits are generous (10k/10s for orders) but the panel
 * still polls this every 15s, so the whole aggregate is cached.
 */
router.get('/dashboard', async (_req, res, next) => {
  try {
    const data = await cached('coin:dashboard', 2_000, async () => {
      const settled = await Promise.allSettled([
        coinswitch.validateKeys(),
        coinswitch.allPairsTicker(EXCHANGE),
        coinswitch.depth('BTC/INR', EXCHANGE),
        coinswitch.trades('BTC/INR', EXCHANGE),
      ]);

      const [status, allPairs, depth, trades] = settled.map((s) =>
        s.status === 'fulfilled' ? s.value : null,
      );
      const errors = settled
        .map((s, i) => (s.status === 'rejected' ? { step: i, message: s.reason?.message || String(s.reason) } : null))
        .filter(Boolean);

      const pairs = Object.values(allPairs?.data || {}).map(pairRow);
      pairs.sort((a, b) => b.quoteVolume - a.quoteVolume);

      const d = depth?.data || {};
      const t = trades?.data || [];

      return {
        valid: status?.message === 'Valid Access',
        apiKey: coinSwitchPublicKey(),
        exchange: EXCHANGE,
        topPairs: pairs.slice(0, 12),
        quoteCurrency: 'INR',
        focus: {
          symbol: 'BTC/INR',
          bids: (d.bids || []).slice(0, 8).map(([price, qty]) => ({ price: Number(price), quantity: Number(qty) })),
          asks: (d.asks || []).slice(0, 8).map(([price, qty]) => ({ price: Number(price), quantity: Number(qty) })),
          trades: t.slice(0, 15).map(normalizeTrade),
        },
        errors,
      };
    });

    res.json({ ok: true, ...data });
  } catch (err) {
    if (err instanceof CoinSwitchApiError) {
      res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
        ok: false,
        error: err.message,
        code: 'COINSWITCH_ERROR',
      });
      return;
    }
    next(err);
  }
});

export default router;
