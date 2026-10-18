import { Router } from 'express';
import { getToken, tokenInfo } from '../growwClient.js';
import { issueSession, verifySession, revokeSession, sessionCount } from '../authSession.js';
import { findUserByUsername, createUser } from '../db.js';
import { verifyPassword } from '../password.js';

const router = Router();

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.replace(/^Bearer\s+/i, '').trim();
}

/** Current Groww token/session state — never returns the token itself. */
router.get('/status', (req, res) => {
  res.json({ ok: true, ...tokenInfo() });
});

/**
 * POST /api/auth/login — verify credentials against the PostgreSQL user store
 * and issue a session token. Passwords are checked with scrypt + timing-safe
 * compare; the password itself is never logged or returned.
 */
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !String(username).trim()) {
    return res.status(400).json({ ok: false, error: 'Username is required.' });
  }
  if (!password) {
    return res.status(400).json({ ok: false, error: 'Password is required.' });
  }

  try {
    const user = await findUserByUsername(username);
    if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
      return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
    }

    const session = issueSession({ userId: user.username, broker: 'dashboard' });
    return res.json({
      ok: true,
      authorized: true,
      token: session.token,
      expiresAt: session.expiresAt,
      user: { username: user.username },
    });
  } catch (err) {
    // Express 4 does not catch async rejections — surface DB failures clearly.
    console.error(`[auth] login failed: ${err.message}`);
    return res.status(503).json({ ok: false, error: 'User database unavailable. Is PostgreSQL running?' });
  }
});

/**
 * POST /api/auth/register — add a user to the database.
 * Used by the "Add User" panel on the login screen.
 */
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body || {};
  try {
    const user = await createUser({ username, email, password });
    return res.status(201).json({ ok: true, user });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

/** GET /api/auth/verify — is the presented token still valid? */
router.get('/verify', (req, res) => {
  const result = verifySession(bearer(req));
  if (!result.valid) {
    return res.status(401).json({ ok: false, valid: false, error: 'Session expired or invalid.' });
  }
  return res.json({ ok: true, valid: true, user: { broker: result.broker, userId: result.userId } });
});

/** POST /api/auth/logout — revoke the presented token. */
router.post('/logout', (req, res) => {
  revokeSession(bearer(req));
  res.json({ ok: true, revoked: true });
});

/** Force a fresh Groww token. */
router.post('/refresh', async (req, res, next) => {
  try {
    await getToken({ force: true });
    res.json({ ok: true, refreshed: true, ...tokenInfo() });
  } catch (err) {
    next(err);
  }
});

/** Lightweight admin view of active sessions (count only — never tokens). */
router.get('/sessions', (_req, res) => {
  res.json({ ok: true, active: sessionCount() });
});

export default router;
