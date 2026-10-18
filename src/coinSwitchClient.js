import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * CoinSwitch PRO API client.
 *
 * Auth is Ed25519 request signing (no token, no session). The public key that
 * goes in `X-AUTH-APIKEY` is DERIVED from the secret — CoinSwitch shows you the
 * derived public key in the PRO profile, so a pasted "api key" that does not
 * match the secret is the #1 integration failure.
 */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export class CoinSwitchApiError extends Error {
  constructor(message, { status = 500, path = null } = {}) {
    super(message);
    this.name = 'CoinSwitchApiError';
    this.status = status;
    this.path = path;
  }
}

let privateKey = null;
let apiKey = null;
let initialised = false;

export function initCoinSwitch() {
  const secret = config.coinSwitchSecret;
  if (!secret) {
    throw new CoinSwitchApiError('COINSWITCH_SECRET is not set', { status: 500 });
  }
  const seed = Buffer.from(secret, 'hex');
  if (seed.length !== 32) {
    throw new CoinSwitchApiError(
      `COINSWITCH_SECRET must be a 32-byte hex string (64 chars), got ${seed.length} bytes`,
      { status: 500 },
    );
  }
  privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  // Derive the public key — this is the value CoinSwitch calls the "API key".
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  apiKey = Buffer.from(jwk.x, 'base64url').toString('hex');
  initialised = true;
  return apiKey;
}

export function coinSwitchPublicKey() {
  if (!initialised) initCoinSwitch();
  return apiKey;
}

/** Headers for one signed request, exactly as the docs' reference client builds them. */
function signedHeaders(method, path) {
  const epoch = String(Date.now());
  // Path must be URL-decoded before signing (e.g. %2F -> /), per the docs.
  const decodedPath = decodeURIComponent(path.replace(/\+/g, ' '));
  const message = method.toUpperCase() + decodedPath + epoch;
  return {
    'Content-Type': 'application/json',
    'X-AUTH-APIKEY': apiKey,
    'X-AUTH-SIGNATURE': crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex'),
    'X-AUTH-EPOCH': epoch,
  };
}

/**
 * Signed GET against the CoinSwitch PRO API.
 * `params` are appended to the path before signing.
 */
export async function coinGet(path, { params = null, timeoutMs = 12000 } = {}) {
  if (!initialised) initCoinSwitch();
  let fullPath = path;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    fullPath += (fullPath.includes('?') ? '&' : '?') + qs;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(config.coinSwitchBaseUrl + fullPath, {
      method: 'GET',
      headers: signedHeaders('GET', fullPath),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new CoinSwitchApiError(`CoinSwitch request timed out: ${path}`, { status: 504, path });
    }
    throw new CoinSwitchApiError(`CoinSwitch request failed: ${err.message}`, { status: 502, path });
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  const text = await res.text();
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }

  if (!res.ok) {
    const msg = body?.message || `HTTP ${res.status}`;
    throw new CoinSwitchApiError(msg, { status: res.status, path });
  }
  return body;
}

export const coinswitch = {
  /** Verify the key pair — useful as a health check. */
  validateKeys: () => coinGet('/trade/api/v2/validate/keys'),

  /** 24hr stats for every pair on an exchange. */
  allPairsTicker: (exchange = 'coinswitchx') =>
    coinGet('/trade/api/v2/24hr/all-pairs/ticker', { params: { exchange } }),

  /** 24hr stats for one or more symbols. */
  ticker: (symbol, exchange = 'coinswitchx') =>
    coinGet('/trade/api/v2/24hr/ticker', { params: { exchange, symbol } }),

  /** Order book. */
  depth: (symbol, exchange = 'coinswitchx') =>
    coinGet('/trade/api/v2/depth', { params: { exchange, symbol } }),

  /** OHLCV candles. interval is minutes; start/end are Unix ms. */
  candles: (symbol, interval, startTime, endTime, exchange = 'coinswitchx') =>
    coinGet('/trade/api/v2/candles', {
      params: { exchange, symbol, interval: String(interval), start_time: String(startTime), end_time: String(endTime) },
    }),

  /** Recent public trades. */
  trades: (symbol, exchange = 'coinswitchx') =>
    coinGet('/trade/api/v2/trades', { params: { exchange, symbol } }),

  /** Account endpoints — often rejected for market-data-only keys. */
  portfolio: () => coinGet('/trade/api/v2/user/portfolio'),
  orders: (open = true, exchange = 'coinswitchx') =>
    coinGet('/trade/api/v2/orders', { params: { open: String(open), exchanges: exchange } }),
};
