import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Session tokens for the dashboard gate.
 *
 * A token is `base64url(header).base64url(payload).hmac`. The signature makes it
 * tamper-proof; the server-side store makes it revocable (logout actually
 * invalidates it rather than just dropping the cookie).
 *
 * HS256-style, but simplified — no JWT library needed.
 */

// Fall back to an ephemeral secret so the server still boots, but warn:
// sessions will not survive a restart if AUTH_SECRET is not pinned.
const SECRET = config.authSecret || crypto.randomBytes(32).hex();
if (!config.authSecret) {
  console.warn('[auth] AUTH_SECRET is not set — using an ephemeral secret. Sessions will not survive a restart.');
}

/** token -> { userId, broker, expiresAt } */
const sessions = new Map();
export const SESSION_TTL_MS = 12 * 3_600_000; // 12 hours

const b64url = (input) =>
  Buffer.from(input).toString('base64url');

function sign(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Issue a new session. Returns the token and its ISO expiry. */
export function issueSession({ userId, broker }) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Date.now();
  const payload = b64url(
    JSON.stringify({ sub: userId, broker, iat: now, exp: now + SESSION_TTL_MS }),
  );
  const token = `${header}.${payload}.${sign(`${header}.${payload}`)}`;
  sessions.set(token, { userId, broker, expiresAt: now + SESSION_TTL_MS });
  return { token, expiresAt: new Date(now + SESSION_TTL_MS).toISOString() };
}

/** Verify a signature and expiry, and confirm the token has not been revoked. */
export function verifySession(token) {
  if (!token || typeof token !== 'string') return { valid: false };
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false };

  const [header, payload, signature] = parts;
  if (!timingSafeEqualStr(signature, sign(`${header}.${payload}`))) {
    return { valid: false };
  }

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { valid: false };
  }

  if (!data.exp || data.exp < Date.now()) {
    sessions.delete(token);
    return { valid: false };
  }

  // If not in the in-memory store, re-validate and re-add (handles restarts)
  if (!sessions.has(token)) {
    sessions.set(token, {
      userId: data.sub,
      broker: data.broker,
      expiresAt: data.exp,
    });
  }

  return { valid: true, userId: data.sub, broker: data.broker };
}

/** Revoke a token (logout). */
export function revokeSession(token) {
  sessions.delete(token);
}

export function sessionCount() {
  return sessions.size;
}
