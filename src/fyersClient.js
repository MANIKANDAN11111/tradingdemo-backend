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

const FYERS_BASE = 'https://api-t1.fyers.in';
const FYERS_DATA_BASE = 'https://api-t1.fyers.in/data';

let tokenState = loadToken();
/**
 * Set when Fyers refuses the refresh grant for a structural reason. Fyers
 * disabled the refresh-token API for SEBI compliance, so once this is set the
 * bot can never renew its own token and must be re-authorized in a browser.
 */
let refreshUnavailable = null;

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

  const secretHash = createHash('sha256').update(appSecret).digest('hex');
  const res = await fetch(`${FYERS_BASE}/api/v3/validate-authcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: appId,
      secret: appSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      secret_hash: secretHash,
      // Required by the current Fyers API, and camelCase — the snake_case form
      // is rejected with "app id hash is required".
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

  // The refresh grant lives on its own endpoint and takes the refresh_token
  // (not `code`). It also requires the user's PIN — set FYERS_PIN in .env.
  const res = await fetch(`${FYERS_BASE}/api/v3/validate-refresh-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      appIdHash: appIdHash(appId, appSecret),
      refresh_token: tokenState.refreshToken,
      ...(process.env.FYERS_PIN ? { pin: process.env.FYERS_PIN } : {}),
    }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || json?.s !== 'ok' || !json?.access_token) {
    const msg = json?.message || json?.msg || `Fyers token refresh failed (HTTP ${res.status})`;
    // Remember a structural refusal so health can explain it, rather than
    // reporting a plain refresh failure every keep-alive cycle.
    if (/SEBI/i.test(msg)) {
      refreshUnavailable =
        `${msg} The bot cannot renew its token automatically — re-authorize it in a browser ` +
        `(GET /api/fyers/auth-url) whenever the access token expires.`;
    }
    throw new FyersApiError(msg, { status: res.status });
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
 * Pacing and 429 circuit breaker.
 *
 * Fyers' Standard-plan Data API allowance is 5 req/s and 50 req/min, and
 * breaching the per-minute cap more than 3 times in a day blocks the account
 * for the rest of the day. A plain retry loop therefore does not recover — it
 * converts a transient limit into a permanent ban. This module throttles
 * outbound calls and refuses to retry into a ban.
 * ------------------------------------------------------------------------- */

const MAX_IN_FLIGHT = 4;
const MAX_COOLDOWN_MS = 30 * 60_000;

let inFlight = 0;
const waiters = [];

const breaker = {
  openUntil: 0,
  consecutive429: 0,
  // How many times the circuit has tripped since the last success. Drives the
  // cooldown ladder below, so a persistent limit backs off harder each time.
  circuitOpens: 0,
  // Set on the first successful response. The token file only records what WE
  // think the expiry is; Fyers can revoke a token early, so local validity is
  // not proof the credential works.
  verifiedAt: 0,
};

/** Escalating cooldowns: 30s → 2min → 5min → 30min. */
const COOLDOWN_LADDER_MS = [30_000, 120_000, 300_000, MAX_COOLDOWN_MS];

async function acquireSlot() {
  if (Date.now() < breaker.openUntil) {
    throw new FyersApiError(
      `Fyers circuit open until ${new Date(breaker.openUntil).toISOString()} — ` +
      `rate-limited, backing off instead of retrying into a ban`,
      { status: 429, code: 'CIRCUIT_OPEN', path: null },
    );
  }
  while (inFlight >= MAX_IN_FLIGHT) {
    await new Promise((resolve) => waiters.push(resolve));
  }
  inFlight += 1;
}

function releaseSlot() {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next();
}

async function withSlot(fn) {
  await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

export function fyersBreakerStatus() {
  return {
    open: Date.now() < breaker.openUntil,
    openUntil: breaker.openUntil ? new Date(breaker.openUntil).toISOString() : null,
    consecutive429: breaker.consecutive429,
    circuitOpens: breaker.circuitOpens,
    verified: Boolean(breaker.verifiedAt),
    verifiedAt: breaker.verifiedAt ? new Date(breaker.verifiedAt).toISOString() : null,
    inFlight,
    queued: waiters.length,
  };
}

/** Broker-facing health summary, for the engine and the UI. */
export function fyersHealth() {
  const info = fyersTokenInfo();
  const status = fyersBreakerStatus();
  const problems = [];
  if (!info.hasToken) problems.push('No Fyers access token — authorize at /api/fyers/auth first.');
  else if (!info.valid) problems.push(`Fyers token expired at ${info.expiresAt}.`);
  if (status.open) problems.push(`Fyers circuit open until ${status.openUntil} (rate-limited).`);
  if (refreshUnavailable) problems.push(refreshUnavailable);
  return {
    // `ok` means "would work right now". A token the broker has revoked still
    // looks valid locally, so unverified is not the same as working.
    ok: Boolean(info.valid) && !status.open && status.verified,
    tokenValid: info.valid,
    verified: status.verified,
    note: status.verified
      ? null
      : 'Token not yet verified against Fyers — local expiry is only our own record, and Fyers can revoke early.',
    refreshUnavailable,
    token: info,
    breaker: status,
    problems,
  };
}

function note429(path, res, text) {
  breaker.consecutive429 += 1;
  breaker.circuitOpens += 1;
  const retryAfterMs = Number(res.headers.get('retry-after') || 0) * 1000;
  const step = COOLDOWN_LADDER_MS[Math.min(breaker.circuitOpens - 1, COOLDOWN_LADDER_MS.length - 1)];
  const cooldown = Math.min(MAX_COOLDOWN_MS, Math.max(step, retryAfterMs));
  breaker.openUntil = Date.now() + cooldown;

  const raw = (text || '').trim();
  const body = raw && !/^too many requests$/i.test(raw) ? ` — ${raw.slice(0, 140)}` : '';
  throw new FyersApiError(
    `Fyers rate-limited (HTTP 429) on ${path}` +
      `${retryAfterMs ? `, retry-after ${Math.round(retryAfterMs / 1000)}s` : ''}${body}. ` +
      `Backing off for ${Math.round(cooldown / 1000)}s ` +
      `(circuit trip #${breaker.circuitOpens}).`,
    { status: 429, code: 'RATE_LIMITED', path },
  );
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

export async function fyersRequest(path, opts = {}) {
  return withSlot(() => doFyersRequest(path, opts));
}

async function doFyersRequest(path, { method = 'GET', query, body, base = FYERS_BASE, _retried = false } = {}) {
  const { accessToken } = await getToken();
  // Fyers requires "app_id:access_token" — a Bearer token is rejected with
  // HTTP 401 "Please provide AppId with access token".
  const url = `${base}${path}${buildQuery(query)}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `${fyersConfig.appId}:${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }

  if (res.status === 401 && !_retried) {
    await getToken({ force: true });
    return doFyersRequest(path, { method, query, body, base, _retried: true });
  }

  // 429 is a limit, not a transient blip: retrying makes it worse, and Fyers
  // blocks the account for the rest of the day after repeated breaches.
  if (res.status === 429) note429(path, res, text);
  breaker.consecutive429 = 0;

  if (!res.ok || json?.s === 'error') {
    const raw = (text || '').trim();
    const snippet = raw && !/^too many requests$/i.test(raw) ? ` — ${raw.slice(0, 140)}` : '';
    throw new FyersApiError(
      json?.message || json?.msg || `HTTP ${res.status} on ${path}${snippet}`,
      { status: res.status, code: json?.code ?? null, path }
    );
  }

  // A 200 with s:"ok" is the only proof the credential actually works, and it
  // clears the escalation ladder.
  breaker.verifiedAt = Date.now();
  breaker.circuitOpens = 0;
  return json;
}

/* ---------------------------------------------------------------------------
 * Typed endpoint helpers
 * ------------------------------------------------------------------------- */

export const fyers = {
  /** Get quotes for symbols. symbols: 'NSE:NIFTY50-INDEX' format */
  quotes: (symbols) => fyersRequest('/quotes', {
    query: { symbols: [].concat(symbols).join(',') },
    base: FYERS_DATA_BASE,
  }).then((p) => p?.d ?? []),

  /** Get detailed quote for one symbol */
  quote: (symbol) => fyersRequest('/quotes', {
    query: { symbols: symbol, flags: 2 },
    base: FYERS_DATA_BASE,
  }).then((p) => p?.d?.[0] ?? null),

  /** Get market depth */
  depth: (symbol) => fyersRequest('/depth', {
    query: { symbol, oh_lc: '1' },
    base: FYERS_DATA_BASE,
  }).then((p) => p?.d ?? null),

  /**
   * Place an order.
   *
   * Fyers answers `{ s, code, id, message }` with NO `d` wrapper (unlike the
   * data endpoints), so the raw `d` is always null — the order id lives at the
   * top level. Normalising here keeps callers from reading a null order id and
   * recording a PENDING row that never resolves.
   */
  placeOrder: (order) => fyersRequest('/api/v3/place-orders', {
    method: 'POST', body: order,
  }).then((p) => ({
    orderId: p?.id ?? null,
    code: p?.code ?? null,
    message: p?.message ?? null,
    raw: p,
  })),

  /** Get positions */
  positions: () => fyersRequest('/api/v3/positions').then((p) => p?.netPositions ?? p?.d ?? []),

  /** Get funds / margins */
  funds: () => fyersRequest('/api/v3/funds').then((p) => p?.fund_limit ?? p?.d ?? []),

  /** Get orders */
  orders: () => fyersRequest('/api/v3/orders').then((p) => p?.orderBook ?? p?.d ?? []),

  /** Get trade book */
  trades: () => fyersRequest('/api/v3/tradebook').then((p) => p?.tradeBook ?? p?.d ?? []),

  /** Get holdings */
  holdings: () => fyersRequest('/api/v3/holdings').then((p) => p?.holdings ?? p?.d ?? []),

  /**
   * Option chain for an underlying. Indices need the -INDEX form
   * (NSE:NIFTY50-INDEX); equities use NSE:SBIN-EQ.
   * `timestamp` (epoch seconds) selects a specific expiry; omit for nearest.
   * Returns { expiryData, optionsChain } where each leg carries symbol,
   * option_type, strike_price, ltp, bid, ask — and the spot row is
   * option_type "" / strike_price -1.
   */
  optionChain: (symbol, { strikecount = 25, timestamp } = {}) =>
    fyersRequest('/options-chain-v3', {
      query: {
        symbol,
        strikecount: String(strikecount),
        ...(timestamp ? { timestamp: String(timestamp) } : {}),
      },
      base: FYERS_DATA_BASE,
    }).then((p) => p?.data ?? p?.d ?? null),
};
