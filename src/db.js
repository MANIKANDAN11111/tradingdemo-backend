import pg from 'pg';
import { config } from './config.js';
import { hashPassword } from './password.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

/** Create the users table and seed a default account on first run. */
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      email VARCHAR(255),
      password_hash VARCHAR(255) NOT NULL,
      salt VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n > 0) return null;

  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const { salt, hash } = hashPassword(password);
  await pool.query(
    'INSERT INTO users (username, email, password_hash, salt) VALUES ($1, $2, $3, $4)',
    ['admin', null, hash, salt],
  );
  return { username: 'admin', password };
}

export async function findUserByUsername(username) {
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [
    String(username || '').trim(),
  ]);
  return rows[0] || null;
}

export async function findUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function listUsers() {
  const { rows } = await pool.query(
    'SELECT id, username, email, created_at FROM users ORDER BY id DESC',
  );
  return rows;
}

export async function createUser({ username, email, password }) {
  const cleanUsername = String(username || '').trim();
  if (!cleanUsername) throw new Error('Username is required.');
  if (!password) throw new Error('Password is required.');

  const existing = await findUserByUsername(cleanUsername);
  if (existing) throw new Error('That username is already taken.');

  const { salt, hash } = hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO users (username, email, password_hash, salt)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, email, created_at`,
    [cleanUsername, email ? String(email).trim() : null, hash, salt],
  );
  return rows[0];
}

export async function deleteUser(id) {
  const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [id]);
  return rowCount > 0;
}
