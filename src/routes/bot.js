import { Router } from 'express';
import * as engine from '../bot/engine.js';
import {
  listOrders, listTrades, getAllPositions, getEquityCurve,
  listStrategies, upsertStrategy,
} from '../bot/store.js';
import { loadConfig, saveConfig, normaliseStrategy } from '../bot/strategy.js';
import { tradeRow, positionRow } from '../bot/grid.js';

const router = Router();

/* Express 4 does not catch async rejections, so every handler is wrapped. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* --------------------------------------------------------------- status - */

router.get('/status', wrap(async (req, res) => {
  res.json({ ok: true, status: await engine.status() });
}));

router.get('/log', wrap(async (req, res) => {
  res.json({ ok: true, log: await engine.recentLog(Number(req.query.n ?? 50)) });
}));

/* ------------------------------------------------------------- controls - */

router.post('/start', wrap(async (req, res) => {
  const r = await engine.start();
  res.status(r.ok ? 200 : 409).json(r.ok
    ? { ok: true, state: r.state }
    : { ok: false, reason: r.reason });
}));

router.post('/stop', wrap(async (req, res) => {
  res.json({ ok: true, ...(await engine.stop()) });
}));

router.post('/halt', wrap(async (req, res) => {
  res.json({ ok: true, ...(await engine.halt(req.body?.reason || 'manual halt')) });
}));

router.post('/mode', wrap(async (req, res) => {
  const r = await engine.setMode(req.body?.mode);
  res.status(r.ok ? 200 : 400).json(r);
}));

router.post('/arm', wrap(async (req, res) => {
  const r = await engine.arm();
  res.status(r.ok ? 200 : 409).json(r);
}));

router.post('/disarm', wrap(async (req, res) => {
  res.json({ ok: true, ...(await engine.disarm()) });
}));

/* ------------------------------------------------------------------ data - */

router.get('/orders', wrap(async (req, res) => {
  const rows = await listOrders({
    mode: req.query.mode ?? undefined,
    limit: Number(req.query.limit ?? 100),
  });
  res.json({ ok: true, orders: rows });
}));

router.get('/trades', wrap(async (req, res) => {
  const rows = await listTrades({
    mode: req.query.mode ?? undefined,
    limit: Number(req.query.limit ?? 100),
  });
  res.json({ ok: true, trades: rows });
}));

/**
 * Grid-ready trades — flat display rows for the broker dashboard's
 * "Recent bot trades" table (Date / Day / Type / Symbol / Side / Entry /
 * Exit / Qty / Capital / P&L / Est. charges / Net P&L / Reason).
 */
router.get('/trades/grid', wrap(async (req, res) => {
  const rows = await listTrades({
    mode: req.query.mode ?? undefined,
    limit: Number(req.query.limit ?? 100),
  });
  res.json({ ok: true, trades: rows.map(tradeRow) });
}));

/** Grid-ready positions, open and closed. */
router.get('/positions/grid', wrap(async (req, res) => {
  const rows = await getAllPositions({
    mode: req.query.mode ?? undefined,
    limit: Number(req.query.limit ?? 100),
  });
  res.json({ ok: true, positions: rows.map(positionRow) });
}));

router.get('/positions', wrap(async (req, res) => {
  const rows = await getAllPositions({
    mode: req.query.mode ?? undefined,
    limit: Number(req.query.limit ?? 100),
  });
  res.json({ ok: true, positions: rows });
}));

router.get('/equity', wrap(async (req, res) => {
  const rows = await getEquityCurve(req.query.mode ?? 'paper', Number(req.query.limit ?? 200));
  res.json({ ok: true, equity: rows });
}));

/* ----------------------------------------------------------- strategies - */

router.get('/strategies', wrap(async (req, res) => {
  const { strategies, settings } = await loadConfig();
  const stored = await listStrategies();
  // The config file is the source of truth; stored rows let us remember the
  // enabled flag across a config edit.
  const enabledMap = new Map(stored.map((s) => [s.id, s.enabled]));
  res.json({
    ok: true,
    settings,
    strategies: strategies.map((s) => ({
      ...s,
      enabled: enabledMap.has(s.id) ? enabledMap.get(s.id) : s.enabled,
    })),
  });
}));

router.post('/strategies/:id/toggle', wrap(async (req, res) => {
  const id = req.params.id;
  const enabled = Boolean(req.body?.enabled);
  const { strategies } = await loadConfig();
  const target = strategies.find((s) => s.id === id);
  if (!target) return res.status(404).json({ ok: false, error: `unknown strategy "${id}"` });

  target.enabled = enabled;
  const next = await saveConfig({ strategies });
  await upsertStrategy({ id, name: target.name, enabled, config: target });
  res.json({ ok: true, strategies: next.strategies });
}));

/** Replace one strategy's config. Body is a normal strategy object. */
router.put('/strategies/:id', wrap(async (req, res) => {
  const id = req.params.id;
  try {
    normaliseStrategy(req.body);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  const { strategies } = await loadConfig();
  const idx = strategies.findIndex((s) => s.id === id);
  const next = [...strategies];
  const merged = normaliseStrategy({ ...req.body, id });
  if (idx === -1) next.push(merged);
  else next[idx] = merged;
  const saved = await saveConfig({ strategies: next });
  await upsertStrategy({ id, name: merged.name, enabled: merged.enabled, config: merged });
  res.json({ ok: true, strategies: saved.strategies });
}));

/** Change bot settings (capital, loss limits, exposure caps). */
const SETTING_KEYS = [
  'capital', 'maxLossPerDay', 'maxLossPerTrade', 'maxSectorExposurePct',
  'defaultCapitalPerTrade', 'slippagePct', 'pollSeconds',
];

router.put('/settings', wrap(async (req, res) => {
  const patch = {};
  for (const key of SETTING_KEYS) {
    if (req.body?.[key] !== undefined) patch[key] = Number(req.body[key]);
  }
  await saveConfig({ settings: patch });
  res.json({ ok: true, settings: (await loadConfig()).settings });
}));

export default router;
