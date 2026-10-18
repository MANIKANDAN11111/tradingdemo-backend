import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fyersConfig } from './config.js';

const TOKEN_FILE = new URL('../../.fyers-token.json', import.meta.url);

export class FyersApiError extends Error {
  constructor(message, { status = 500, code = null, path = null } = {}) {
    super(message);
    this.name = 'FyersApiError';
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

/* ---------------------------------------------------------------------------
 * Fyers OAuth2 flow:
 *   1. Generate auth URL for the user to visit
 *   2. User authorizes → redirect with ?auth_code=XXX
 *   3. Exchange auth_code + secret_hash for access_token
 *   4. Use access_token for all API calls
 * ------------------------------------------------------------------------- */

const FYERS_BASE = 'https://api.fyers.in';
const FYERS_DATA_BASE = 'https://api.fyers.in/data-rest';

let tokenState = loadToken();

function loadToken() {
  try {
    if (!existsSync(TOKEN_FILE)) return { accessToken: null, refreshToken: null, expiresAt: 0, appId: null };
    const data = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    return {
      accessToken: data.accessToken || null,
      refreshToken: data.refreshToken || null,
      expiresAt: data.expiresAt || 0,
      appId: data.appId || null,
    };
  } catch {
    return { accessToken: null, refreshToken: null, expiresAt: 0, appId: null };
  }
}

function saveToken() {
  try {
    writeFileSync(TOKEN_FILE, JSON.stringify(tokenState, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[fyers] token save failed: ${e.message}`);
  }
}

function secretHash(secret) {
  return createHash('sha256').update(secret).digest('hex');
}

/** appIdHash = SHA256(app_id + ":" + secret_id) */
function appIdHash(appId, secret) {
  return createHash('sha256').update(`${appId}:${secret}`).digest('hex');
}

/** Generate the OAuth2 authorization URL the user must visit once. */
export function getAuthUrl() {
  const { appId, redirectUri } = fyersConfig;
  if (!appId) throw new FyersApiError('Fyers appId is not configured');
  // Fyers validate-auth expects the app ID without any suffix
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state: 'bot',
  });
  return `${FYERS_BASE}/api/v3/generate-authcode?${params.toString()}`;
}

/**
 * Exchange an auth_code for an access_token.
 * The user must visit getAuthUrl(), authorize, and paste the auth_code here.
 */
export async function exchangeAuthCode(authCode) {
  const { appId, appSecret, redirectUri } = fyersConfig;
  if (!appId || !appSecret) throw new FyersApiError('Fyers credentials not configured');

  const res = await fetch(`${FYERS_BASE}/api/v3/validate-authcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      appIdHash: appIdHash(appId, appSecret),
      code: authCode,
    }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || json?.s !== 'ok') {
    throw new FyersApiError(
      json?.message || json?.msg || `Fyers token exchange failed (HTTP ${res.status})`,
      { status: res.status, code: json?.code ?? null, path: '/api/v3/validate-authcode' }
    );
  }

  tokenState = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    expiresAt: Date.now() + 86400 * 1000,
    appId,
  };
  saveToken();
  return tokenState;
}

export async function getToken({ force = false } = {}) {
  if (!force && tokenState.accessToken && Date.now() < tokenState.expiresAt) {
    return tokenState;
  }
  if (tokenState.refreshToken) {
    return refreshAccessToken();
  }
  throw new FyersApiError('No Fyers token — call exchangeAuthCode() first');
}

export async function refreshAccessToken() {
  const { appId, appSecret } = fyersConfig;
  if (!tokenState.refreshToken) throw new FyersApiError('No refresh token available');
  if (!appId || !appSecret) throw new FyersApiError('Fyers credentials not configured');

  // Fyers validates the refresh grant against the authcode endpoint with the
  // appIdHash + a PIN. The token is sent as `code` under grant_type=refresh_token.
  const res = await fetch(`${FYERS_BASE}/api/v3/validate-authcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      appIdHash: appIdHash(appId, appSecret),
      code: tokenState.refreshToken,
      ...(process.env.FYERS_PIN ? { pin: process.env.FYERS_PIN } : {}),
    }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || json?.s !== 'ok' || !json?.access_token) {
    throw new FyersApiError(
      json?.message || json?.msg || `Fyers token refresh failed (HTTP ${res.status})`,
      { status: res.status }
    );
  }

  tokenState.accessToken = json.access_token;
  tokenState.refreshToken = json.refresh_token || tokenState.refreshToken;
  tokenState.expiresAt = Date.now() + (json.expires_in || 86400) * 1000;
  saveToken();
  return tokenState;
}

export function fyersTokenInfo() {
  return {
    hasToken: Boolean(tokenState.accessToken),
    expiresAt: tokenState.expiresAt ? new Date(tokenState.expiresAt).toISOString() : null,
    appId: tokenState.appId,
    valid: Boolean(tokenState.accessToken) && Date.now() < tokenState.expiresAt,
  };
}

/* ---------------------------------------------------------------------------
 * Request helper
 * ------------------------------------------------------------------------- */

function buildQuery(query) {
  if (!query) return '';
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export async function fyersRequest(path, { method = 'GET', query, body, base = FYERS_BASE, _retried = false } = {}) {
  const { accessToken } = await getToken();
  const url = `${base}${path}${buildQuery(query)}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }

  if (res.status === 401 && !_retried) {
    await getToken({ force: true });
    return fyersRequest(path, { method, query, body, base, _retried: true });
  }

  if (!res.ok || json?.s === 'error') {
    throw new FyersApiError(
      json?.message || json?.msg || `HTTP ${res.status} on ${path}`,
      { status: res.status, code: json?.code ?? null, path }
    );
  }

  return json;
}

/* ---------------------------------------------------------------------------
 * Typed endpoint helpers
 * ------------------------------------------------------------------------- */

export const fyers = {
  /** Get quotes for symbols. symbols: 'NSE:NIFTY50-INDEX' format */
  quotes: (symbols) => fyersRequest('/v2/quotes', {
    query: { symbols: [].concat(symbols).join(',') },
    base: FYERS_DATA_BASE,
  }).then((p) => p?.d ?? []),

  /** Get detailed quote for one symbol */
  quote: (symbol) => fyersRequest('/v2/quotes', {
    query: { symbols: symbol, flags: 2 },
    base: FYERS_DATA_BASE,
  }).then((p) => p?.d?.[0] ?? null),

  /** Get market depth */
  depth: (symbol) => fyersRequest('/v2/depth', {
    query: { symbol, oh_lc: '1' },
    base: FYERS_DATA_BASE,
  }).then((p) => p?.d ?? null),

  /** Place an order */
  placeOrder: (order) => fyersRequest('/v3/place-orders', {
    method: 'POST', body: order,
  }).then((p) => p?.d ?? null),

  /** Get positions */
  positions: () => fyersRequest('/v3/positions', { method: 'POST', body: {} }).then((p) => p?.d ?? []),

  /** Get funds / margins */
  funds: () => fyersRequest('/v3/funds', { method: 'POST', body: {} }).then((p) => p?.d ?? []),

  /** Get orders */
  orders: () => fyersRequest('/v3/orders', { method: 'POST', body: {} }).then((p) => p?.d ?? []),

  /** Get trade book */
  trades: () => fyersRequest('/v3/tradebook').then((p) => p?.d ?? []),

  /** Get holdings */
  holdings: () => fyersRequest('/v3/holdings').then((p) => p?.d ?? []),
};
