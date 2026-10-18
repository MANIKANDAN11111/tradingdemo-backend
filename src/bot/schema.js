import { pool } from '../db.js';

/**
 * Bot tables. Created on boot alongside the users table.
 *
 * Design notes:
 *  - `bot_state` is a singleton (id = 1) holding mode / running / capital.
 *  - Orders are written BEFORE they are sent anywhere, so a crash mid-flight
 *    still leaves an audit trail.
 *  - Positions and trades are separate: a position is an open exposure, a trade
 *    is the completed round trip with its realised P&L.
 *  - Every row carries `mode` (paper | live) so the two books never mix.
 */
export async function initBotSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      mode           TEXT NOT NULL DEFAULT 'paper',
      running        BOOLEAN NOT NULL DEFAULT false,
      armed          BOOLEAN NOT NULL DEFAULT false,
      capital        NUMERIC(14,2) NOT NULL DEFAULT 100000,
      halted_reason  TEXT,
      started_at     TIMESTAMPTZ,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_strategies (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      enabled     BOOLEAN NOT NULL DEFAULT false,
      config      JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_orders (
      id               SERIAL PRIMARY KEY,
      strategy_id      TEXT NOT NULL,
      mode             TEXT NOT NULL,
      symbol           TEXT NOT NULL,
      exchange         TEXT NOT NULL,
      segment          TEXT NOT NULL,
      side             TEXT NOT NULL,
      quantity         INTEGER NOT NULL,
      order_type       TEXT NOT NULL DEFAULT 'MARKET',
      limit_price      NUMERIC(14,2),
      status           TEXT NOT NULL DEFAULT 'PENDING',
      fill_price       NUMERIC(14,2),
      charges          NUMERIC(14,2) NOT NULL DEFAULT 0,
      broker_order_id  TEXT,
      reason           TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_positions (
      id            SERIAL PRIMARY KEY,
      strategy_id   TEXT NOT NULL,
      mode          TEXT NOT NULL,
      symbol        TEXT NOT NULL,
      exchange      TEXT NOT NULL,
      segment       TEXT NOT NULL,
      side          TEXT NOT NULL,
      quantity      INTEGER NOT NULL,
      avg_price     NUMERIC(14,2) NOT NULL,
      stop_loss     NUMERIC(14,2),
      target        NUMERIC(14,2),
      sector        TEXT,
      opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      closed_at     TIMESTAMPTZ,
      exit_price    NUMERIC(14,2),
      realised_pnl  NUMERIC(14,2)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_trades (
      id            SERIAL PRIMARY KEY,
      position_id   INTEGER REFERENCES bot_positions(id) ON DELETE SET NULL,
      strategy_id   TEXT NOT NULL,
      mode          TEXT NOT NULL,
      symbol        TEXT NOT NULL,
      side          TEXT NOT NULL,
      quantity      INTEGER NOT NULL,
      entry_price   NUMERIC(14,2) NOT NULL,
      exit_price    NUMERIC(14,2) NOT NULL,
      charges       NUMERIC(14,2) NOT NULL DEFAULT 0,
      pnl           NUMERIC(14,2) NOT NULL,
      exit_reason   TEXT,
      opened_at     TIMESTAMPTZ NOT NULL,
      closed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_equity (
      id            SERIAL PRIMARY KEY,
      mode          TEXT NOT NULL,
      equity        NUMERIC(14,2) NOT NULL,
      realised_pnl  NUMERIC(14,2) NOT NULL DEFAULT 0,
      recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_daily (
      day           DATE NOT NULL,
      mode          TEXT NOT NULL,
      realised_pnl  NUMERIC(14,2) NOT NULL DEFAULT 0,
      trades        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, mode)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS bot_orders_strategy_idx ON bot_orders (strategy_id, created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS bot_positions_open_idx ON bot_positions (mode, closed_at)
  `);

  // Ensure the singleton state row exists.
  await pool.query(`
    INSERT INTO bot_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING
  `);
}
