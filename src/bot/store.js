import { pool } from '../db.js';

/* ---------------------------------------------------------------- state --- */

export async function getState() {
  const { rows } = await pool.query('SELECT * FROM bot_state WHERE id = 1');
  const r = rows[0] || {};
  return {
    mode: r.mode ?? 'paper',
    running: Boolean(r.running),
    armed: Boolean(r.armed),
    capital: Number(r.capital ?? 100000),
    haltedReason: r.halted_reason ?? null,
    startedAt: r.started_at ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

export async function setState(patch) {
  const fields = [];
  const values = [];
  const map = {
    mode: 'mode',
    running: 'running',
    armed: 'armed',
    capital: 'capital',
    haltedReason: 'halted_reason',
    startedAt: 'started_at',
  };
  for (const [key, col] of Object.entries(map)) {
    if (patch[key] !== undefined) {
      values.push(patch[key]);
      fields.push(`${col} = $${values.length}`);
    }
  }
  if (!fields.length) return getState();
  fields.push('updated_at = now()');
  await pool.query(`UPDATE bot_state SET ${fields.join(', ')} WHERE id = 1`, values);
  return getState();
}

/* ----------------------------------------------------------- strategies --- */

export async function listStrategies() {
  const { rows } = await pool.query('SELECT * FROM bot_strategies ORDER BY id');
  return rows.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, config: r.config }));
}

export async function upsertStrategy({ id, name, enabled, config }) {
  await pool.query(
    `INSERT INTO bot_strategies (id, name, enabled, config, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           enabled = EXCLUDED.enabled,
           config = EXCLUDED.config,
           updated_at = now()`,
    [id, name, Boolean(enabled), config],
  );
}

export async function setStrategyEnabled(id, enabled) {
  await pool.query('UPDATE bot_strategies SET enabled = $2, updated_at = now() WHERE id = $1', [id, enabled]);
}

/* --------------------------------------------------------------- orders --- */

export async function recordOrder(o) {
  const { rows } = await pool.query(
    `INSERT INTO bot_orders
       (strategy_id, mode, symbol, exchange, segment, side, quantity,
        order_type, limit_price, status, fill_price, charges, broker_order_id, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      o.strategyId, o.mode, o.symbol, o.exchange, o.segment, o.side, o.quantity,
      o.orderType ?? 'MARKET', o.limitPrice ?? null, o.status ?? 'PENDING',
      o.fillPrice ?? null, o.charges ?? 0, o.brokerOrderId ?? null, o.reason ?? null,
    ],
  );
  return rows[0].id;
}

export async function updateOrder(id, patch) {
  const map = {
    status: 'status', fillPrice: 'fill_price', charges: 'charges',
    brokerOrderId: 'broker_order_id', reason: 'reason',
  };
  const fields = [];
  const values = [];
  for (const [key, col] of Object.entries(map)) {
    if (patch[key] !== undefined) {
      values.push(patch[key]);
      fields.push(`${col} = $${values.length}`);
    }
  }
  if (!fields.length) return;
  values.push(id);
  await pool.query(`UPDATE bot_orders SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
}

export async function listOrders({ mode, limit = 100 } = {}) {
  const { rows } = mode
    ? await pool.query('SELECT * FROM bot_orders WHERE mode = $1 ORDER BY created_at DESC LIMIT $2', [mode, limit])
    : await pool.query('SELECT * FROM bot_orders ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows;
}

/* ------------------------------------------------------------ positions --- */

export async function openPosition(p) {
  const { rows } = await pool.query(
    `INSERT INTO bot_positions
       (strategy_id, mode, symbol, exchange, segment, side, quantity, avg_price, stop_loss, target, sector)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [p.strategyId, p.mode, p.symbol, p.exchange, p.segment, p.side, p.quantity,
      p.avgPrice, p.stopLoss ?? null, p.target ?? null, p.sector ?? null],
  );
  return rows[0].id;
}

export async function closePosition(id, { exitPrice, realisedPnl }) {
  await pool.query(
    'UPDATE bot_positions SET closed_at = now(), exit_price = $2, realised_pnl = $3 WHERE id = $1',
    [id, exitPrice, realisedPnl],
  );
}

export async function getOpenPositions(mode) {
  const { rows } = await pool.query(
    'SELECT * FROM bot_positions WHERE mode = $1 AND closed_at IS NULL ORDER BY opened_at',
    [mode],
  );
  return rows;
}

export async function getAllPositions({ mode, limit = 100 } = {}) {
  const { rows } = mode
    ? await pool.query('SELECT * FROM bot_positions WHERE mode = $1 ORDER BY opened_at DESC LIMIT $2', [mode, limit])
    : await pool.query('SELECT * FROM bot_positions ORDER BY opened_at DESC LIMIT $1', [limit]);
  return rows;
}

/* --------------------------------------------------------------- trades --- */

export async function recordTrade(t) {
  const { rows } = await pool.query(
    `INSERT INTO bot_trades
       (position_id, strategy_id, mode, symbol, side, quantity, entry_price, exit_price, charges, pnl, exit_reason, opened_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [t.positionId ?? null, t.strategyId, t.mode, t.symbol, t.side, t.quantity,
      t.entryPrice, t.exitPrice, t.charges ?? 0, t.pnl, t.exitReason ?? null, t.openedAt],
  );
  return rows[0].id;
}

export async function listTrades({ mode, limit = 100 } = {}) {
  const { rows } = mode
    ? await pool.query('SELECT * FROM bot_trades WHERE mode = $1 ORDER BY closed_at DESC LIMIT $2', [mode, limit])
    : await pool.query('SELECT * FROM bot_trades ORDER BY closed_at DESC LIMIT $1', [limit]);
  return rows;
}

/* ------------------------------------------------------- equity + daily --- */

export async function recordEquity(mode, equity, realisedPnl) {
  await pool.query(
    'INSERT INTO bot_equity (mode, equity, realised_pnl) VALUES ($1,$2,$3)',
    [mode, equity, realisedPnl],
  );
}

export async function getEquityCurve(mode, limit = 200) {
  const { rows } = await pool.query(
    'SELECT * FROM bot_equity WHERE mode = $1 ORDER BY recorded_at DESC LIMIT $2',
    [mode, limit],
  );
  return rows.reverse();
}

export async function getDaily(day, mode) {
  const { rows } = await pool.query('SELECT * FROM bot_daily WHERE day = $1 AND mode = $2', [day, mode]);
  return rows[0]
    ? { realisedPnl: Number(rows[0].realised_pnl), trades: rows[0].trades }
    : { realisedPnl: 0, trades: 0 };
}

export async function addDailyPnl(day, mode, pnlDelta, tradeDelta = 1) {
  await pool.query(
    `INSERT INTO bot_daily (day, mode, realised_pnl, trades)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (day, mode) DO UPDATE
       SET realised_pnl = bot_daily.realised_pnl + EXCLUDED.realised_pnl,
           trades = bot_daily.trades + EXCLUDED.trades`,
    [day, mode, pnlDelta, tradeDelta],
  );
}

export async function getTodayRealised(mode) {
  const d = await getDaily(new Date().toISOString().slice(0, 10), mode);
  return d.realisedPnl;
}
