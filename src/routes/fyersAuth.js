import { Router } from 'express';
import { config } from '../config.js';
import { getAuthUrl, exchangeAuthCode, fyersTokenInfo } from '../fyersClient.js';

const router = Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Step 1: return the Fyers OAuth URL the user must visit to authorize. */
router.get('/auth-url', wrap(async (req, res) => {
  try {
    const url = getAuthUrl();
    res.json({ ok: true, url });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}));

/**
 * Step 2: exchange the auth_code (from the redirect) for an access_token.
 * The frontend sends ?auth_code=XXX after the user authorizes on Fyers.
 */
router.get('/token', wrap(async (req, res) => {
  const { auth_code: authCode } = req.query;
  if (!authCode) return res.status(400).json({ ok: false, error: 'auth_code is required' });

  try {
    const token = await exchangeAuthCode(authCode);
    res.json({ ok: true, token });
  } catch (e) {
    res.status(401).json({ ok: false, error: e.message });
  }
}));

/** Step 3: check current Fyers token status. */
router.get('/status', wrap(async (req, res) => {
  res.json({ ok: true, ...fyersTokenInfo() });
}));

/**
 * Step 2b: Fyers OAuth redirect target.
 *
 * This only fires if FYERS_REDIRECT_URI points here. Fyers redirects the
 * browser back with ?auth_code=..., we exchange it for a token, then send the
 * user to the dashboard they actually logged in on (FRONTEND_URL) — the session
 * lives in that origin's localStorage, so sending them to the API port would
 * land them on a login page.
 */
router.get('/callback', wrap(async (req, res) => {
  const { auth_code: authCode, error, error_description } = req.query;
  const back = config.frontendUrl;

  if (error || error_description) {
    const msg = encodeURIComponent(`Fyers auth failed: ${error_description || error}`);
    return res.redirect(`${back}/?fyers_error=${msg}`);
  }
  if (!authCode) {
    return res.redirect(`${back}/?fyers_error=` + encodeURIComponent('No auth_code received from Fyers'));
  }

  try {
    await exchangeAuthCode(authCode);
    return res.redirect(`${back}/?fyers_connected=1`);
  } catch (e) {
    const msg = encodeURIComponent(e.message || 'Token exchange failed');
    return res.redirect(`${back}/?fyers_error=${msg}`);
  }
}));

export default router;
