import { createHash } from 'node:crypto';
import { TOTP } from 'otpauth';
import { config, assertCredentials } from './config.js';

export class GrowwApiError extends Error {
  constructor(message, { status = 500, code = null, path = null } = {}) {
    super(message);
    this.name = 'GrowwApiError';
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

/**
 * Checksum = SHA256(api_secret + timestamp), timestamp in epoch seconds.
 * This is the "approval" flow from the Groww docs.
 */
export function buildChecksum(secret, timestamp) {
  return createHash('sha256').update(secret + timestamp).digest('hex');
}

// ---------------------------------------------------------------------------
// Token management: cached in memory, single-flight, auto-refresh on expiry/401
// ---------------------------------------------------------------------------

let tokenState = { token: null, expiresAt: 0, sessionName: null, tokenRefId: null, active: false };
let inFlight = null;

function parseExpiry(expiry) {
  if (!expiry) return Date.now() + 6 * 60 * 60 * 1000;
  // Groww returns IST wall-clock without a zone, e.g. "2026-10-18T06:00:00".
  const parsed = Date.parse(expiry.length === 19 ? `${expiry}+05:30` : expiry);
  if (Number.isNaN(parsed)) return Date.now() + 6 * 60 * 60 * 1000;
  // Refresh 5 minutes early so a request never rides an expiring token.
  return parsed - 5 * 60 * 1000;
}

async function mintToken() {
  assertCredentials();

  // TOTP flow — no daily expiry, fully automatic
  if (config.totpSecret && config.totpToken) {
    const totp = new TOTP({
      secret: config.totpSecret,
      digits: 6,
      period: 30,
    });
    const code = totp.generate();

    const res = await fetch(`${config.baseUrl}/token/api/access`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.totpToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-API-VERSION': config.apiVersion,
      },
      body: JSON.stringify({ key_type: 'totp', totp: code, timestamp: String(Math.floor(Date.now() / 1000)) }),
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {
      throw new GrowwApiError(`Token endpoint returned non-JSON: ${text.slice(0, 200)}`, { status: res.status, path: '/token/api/access' });
    }
    if (!res.ok || !json.token) {
      throw new GrowwApiError(json?.error?.message || json?.message || `TOTP token request failed (HTTP ${res.status})`, { status: res.status, path: '/token/api/access' });
    }

    tokenState = { token: json.token, expiresAt: parseExpiry(json.expiry), sessionName: json.sessionName ?? null, tokenRefId: json.tokenRefId ?? null, active: json.active ?? true };
    return tokenState;
  }

  // Approval flow — requires daily manual approval
  const timestamp = String(Math.floor(Date.now() / 1000));
  const checksum = buildChecksum(config.apiSecret, timestamp);

  const res = await fetch(`${config.baseUrl}/token/api/access`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-API-VERSION': config.apiVersion,
    },
    body: JSON.stringify({ key_type: 'approval', checksum, timestamp }),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new GrowwApiError(`Token endpoint returned non-JSON: ${text.slice(0, 200)}`, {
      status: res.status,
      path: '/token/api/access',
    });
  }

  if (!res.ok || !json.token) {
    throw new GrowwApiError(
      json?.error?.message || json?.message || `Token request failed (HTTP ${res.status})`,
      { status: res.status, code: json?.error?.code ?? null, path: '/token/api/access' }
    );
  }

  tokenState = {
    token: json.token,
    expiresAt: parseExpiry(json.expiry),
    sessionName: json.sessionName ?? null,
    tokenRefId: json.tokenRefId ?? null,
    active: json.active ?? true,
  };
  return tokenState;
}

export async function getToken({ force = false } = {}) {
  if (!force && tokenState.token && Date.now() < tokenState.expiresAt) {
    return tokenState;
  }
  if (inFlight) return inFlight;
  inFlight = mintToken().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function tokenInfo() {
  return {
    hasToken: Boolean(tokenState.token),
    expiresAt: tokenState.expiresAt ? new Date(tokenState.expiresAt).toISOString() : null,
    sessionName: tokenState.sessionName,
    tokenRefId: tokenState.tokenRefId,
    active: tokenState.active,
    valid: Boolean(tokenState.token) && Date.now() < tokenState.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Request helper
// ---------------------------------------------------------------------------

function buildQuery(query) {
  if (!query) return '';
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const snake = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      const val = Array.isArray(v) ? v.join(',') : v;
      return `${encodeURIComponent(snake)}=${encodeURIComponent(val)}`;
    });
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * Calls a Groww endpoint and unwraps the { status, payload } envelope.
 * Retries once with a fresh token on 401.
 */
export async function request(path, { method = 'GET', query, body, _retried = false } = {}) {
  const { token } = await getToken();
  const url = `${config.baseUrl}${path}${buildQuery(query)}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-API-VERSION': config.apiVersion,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }

  if (res.status === 401 && !_retried) {
    await getToken({ force: true });
    return request(path, { method, query, body, _retried: true });
  }

  if (!res.ok || json?.status === 'FAILURE') {
    throw new GrowwApiError(
      json?.error?.message || `HTTP ${res.status} on ${path}`,
      { status: res.status, code: json?.error?.code ?? null, path }
    );
  }

  // Some endpoints return the payload directly.
  return json?.payload !== undefined ? json.payload : json;
}

// ---------------------------------------------------------------------------
// Typed endpoint helpers (paths taken from the official Groww Node SDK)
// ---------------------------------------------------------------------------

export const groww = {
  holdings: () => request('/holdings/user').then((p) => p?.holdings ?? []),
  positions: (segment = 'CASH') => request('/positions/user', { query: { segment } }).then((p) => p?.positions ?? []),
  margins: () => request('/margins/detail/user'),
  orders: ({ segment = 'CASH', page = 0, pageSize = 50 } = {}) =>
    request('/order/list', { query: { segment, page, pageSize } }).then((p) => p?.orderList ?? []),
  orderDetail: (growwOrderId, segment = 'CASH') => request(`/order/detail/${growwOrderId}`, { query: { segment } }),
  trades: (growwOrderId, segment = 'CASH') =>
    request(`/order/trades/${growwOrderId}`, { query: { segment } }).then((p) => p?.tradeList ?? []),
  ltp: (exchangeSymbols, segment = 'CASH') =>
    request('/live-data/ltp', { query: { segment, exchangeSymbols: [].concat(exchangeSymbols) } }),
  quote: ({ exchange = 'NSE', segment = 'CASH', tradingSymbol }) =>
    request('/live-data/quote', { query: { exchange, segment, tradingSymbol } }),
  ohlc: (exchangeSymbols, segment = 'CASH') =>
    request('/live-data/ohlc', { query: { segment, exchangeSymbols: [].concat(exchangeSymbols) } }),
};
