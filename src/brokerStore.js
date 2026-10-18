import { pool } from './db.js';

/**
 * Initialize the brokers table.
 * A broker is a generic connection to an API (Groww, Fyers, Zerodha, etc).
 */
export async function initBrokersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brokers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      auth_type VARCHAR(50) NOT NULL DEFAULT 'api_key',
      credentials JSONB NOT NULL DEFAULT '{}',
      status VARCHAR(50) NOT NULL DEFAULT 'disconnected',
      status_message TEXT,
      connected_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/** List all brokers (without credentials). */
export async function listBrokers() {
  const { rows } = await pool.query(`
    SELECT id, name, auth_type, status, status_message, connected_at, created_at, updated_at
    FROM brokers ORDER BY id DESC
  `);
  return rows;
}

/** Get a single broker by ID (without credentials). */
export async function getBroker(id) {
  const { rows } = await pool.query(
    `SELECT id, name, auth_type, status, status_message, connected_at, created_at, updated_at
     FROM brokers WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

/** Get a broker with credentials (internal use only). */
export async function getBrokerWithCredentials(id) {
  const { rows } = await pool.query('SELECT * FROM brokers WHERE id = $1', [id]);
  return rows[0] || null;
}

/** Create a new broker. */
export async function createBroker({ name, auth_type, credentials }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Broker name is required.');

  const { rows } = await pool.query(
    `INSERT INTO brokers (name, auth_type, credentials)
     VALUES ($1, $2, $3)
     RETURNING id, name, auth_type, status, status_message, connected_at, created_at, updated_at`,
    [cleanName, auth_type || 'api_key', JSON.stringify(credentials || {})]
  );
  return rows[0];
}

/** Update a broker's credentials. */
export async function updateBroker(id, { name, auth_type, credentials }) {
  const { rows } = await pool.query(
    `UPDATE brokers SET
       name = COALESCE($2, name),
       auth_type = COALESCE($3, auth_type),
       credentials = COALESCE($4, credentials),
       updated_at = now()
     WHERE id = $1
     RETURNING id, name, auth_type, status, status_message, connected_at, created_at, updated_at`,
    [id, name || null, auth_type || null, credentials ? JSON.stringify(credentials) : null]
  );
  return rows[0] || null;
}

/** Update broker status. */
export async function updateBrokerStatus(id, status, statusMessage, connectedAt) {
  const { rows } = await pool.query(
    `UPDATE brokers SET
       status = $2,
       status_message = $3,
       connected_at = $4,
       updated_at = now()
     WHERE id = $1
     RETURNING id, name, auth_type, status, status_message, connected_at, created_at, updated_at`,
    [id, status, statusMessage || null, connectedAt || null]
  );
  return rows[0] || null;
}

/** Delete a broker. */
export async function deleteBroker(id) {
  const { rowCount } = await pool.query('DELETE FROM brokers WHERE id = $1', [id]);
  return rowCount > 0;
}
