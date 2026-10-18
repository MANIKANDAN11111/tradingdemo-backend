import { Router } from 'express';
import { listTrades, getState } from '../bot/store.js';

const router = Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Accuracy analytics, matching the reference UI exactly.
 *
 * For each strategy we return paper and live books separately, each with:
 *   accuracy, won, total, avgWin, avgLoss
 *   and a breakdown by day bucket: expiry days / non-expiry days / Fridays
 *
 * Day buckets follow the reference definitions:
 *   - "expiry days"   — the day the traded option expires, or the day before
 *                      a holiday
 *   - "fridays"       — Fridays that are NOT expiry days
 *   - everything else — "non-expiry days"
 */

/** NSE index weekly expiry weekday. NIFTY → Thursday, SENSEX → Tuesday. */
function expiryWeekday(underlying = '') {
  const u = String(underlying || '').toUpperCase();
  if (u.includes('SENSEX')) return 2; // Tuesday
  if (u.includes('BANKNIFTY')) return 3; // Wednesday
  return 4; // Thursday — NIFTY and everything else
}

/** Thursday/weekday indices for the week containing `date`. */
function holidayAdjacent(date) {
  const d = new Date(date);
  const day = d.getDay();
  // Thursday (4); if today is Friday (5) it is the day after expiry
  if (day === 5) return true;
  return false;
}

function bucketOf(underlying, openedAt) {
  const opened = new Date(openedAt);
  const wd = opened.getDay();
  if (wd === 5) return 'fridays';
  if (wd === expiryWeekday(underlying)) return 'expiry days';
  if (holidayAdjacent(opened)) return 'expiry days';
  return 'non-expiry days';
}

function summarise(trades) {
  const won = trades.filter((t) => Number(t.pnl) > 0);
  const lost = trades.filter((t) => Number(t.pnl) <= 0);
  const sum = (arr) => arr.reduce((a, t) => a + Number(t.pnl), 0);
  const total = trades.length;

  const buckets = {};
  for (const t of trades) {
    const key = bucketOf(t.underlying, t.opened_at);
    buckets[key] = buckets[key] || { trades: 0, won: 0, pnl: 0 };
    buckets[key].trades += 1;
    if (Number(t.pnl) > 0) buckets[key].won += 1;
    buckets[key].pnl += Number(t.pnl);
  }

  const fmtBuckets = {};
  for (const [key, b] of Object.entries(buckets)) {
    fmtBuckets[key] = {
      trades: b.trades,
      winPct: b.trades ? Math.round((b.won / b.trades) * 100) : null,
      pnl: Math.round(b.pnl * 100) / 100,
    };
  }

  return {
    total,
    won: won.length,
    accuracy: total ? Math.round((won.length / total) * 100) : null,
    avgWin: won.length ? Math.round((sum(won) / won.length) * 100) / 100 : null,
    avgLoss: lost.length ? Math.round((sum(lost) / lost.length) * 100) / 100 : null,
    pnl: Math.round(sum(trades) * 100) / 100,
    buckets: fmtBuckets,
  };
}

/** GET /api/bot/analytics — per-strategy paper + live accuracy. */
router.get('/analytics', wrap(async (req, res) => {
  const mode = req.query.mode;
  const { strategies } = await loadStrategiesForAnalytics();
  const all = await listTrades({ mode: mode ?? undefined, limit: 5000 });

  const byMode = { paper: all.filter((t) => t.mode === 'paper') };
  if (!mode) {
    byMode.live = all.filter((t) => t.mode === 'live');
  }

  const result = {};
  for (const s of strategies) {
    result[s.id] = { id: s.id, name: s.name, underlying: s.underlying };
    for (const [m, trades] of Object.entries(byMode)) {
      const mine = trades.filter((t) => t.strategy_id === s.id);
      result[s.id][m] = summarise(mine);
    }
  }

  res.json({ ok: true, strategies: result });
}));

/** GET /api/bot/analytics/summary — one line per strategy, for compact views. */
router.get('/analytics/summary', wrap(async (req, res) => {
  const { strategies } = await loadStrategiesForAnalytics();
  const all = await listTrades({ limit: 5000 });
  res.json({
    ok: true,
    rows: strategies.map((s) => {
      const paper = summarise(all.filter((t) => t.strategy_id === s.id && t.mode === 'paper'));
      const live = summarise(all.filter((t) => t.strategy_id === s.id && t.mode === 'live'));
      return { id: s.id, name: s.name, paper, live };
    }),
  });
}));

async function loadStrategiesForAnalytics() {
  const { loadConfig } = await import('../bot/strategy.js');
  const { strategies } = await loadConfig();
  return {
    strategies: strategies.map((s) => ({
      id: s.id,
      name: s.name,
      underlying: s.instrument.underlying,
    })),
  };
}

export default router;
