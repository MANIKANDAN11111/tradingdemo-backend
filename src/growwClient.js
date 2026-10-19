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

let tokenState = {
  token: null,
  expiresAt: 0,
  sessionName: null,
  tokenRefId: null,
  active: false,
  /** Last mint failure, so health can report the real reason rather than
   *  "no token" — which reads identically for a wrong key and an expired one. */
  lastError: null,
};
let inFlight = null;

/**
 * Classify the configured credentials.
 *
 * The single most common failure here is pasting an ACCESS TOKEN into
 * GROWW_API_KEY. The approval flow then answers HTTP 401
 * "Please Login and Try Again", which reads like an expiry problem and sends
 * you chasing a code fix when the credential is simply the wrong kind of
 * secret. Decoding the JWT locally turns that into an actionable message.
 */
export function credentialDiagnostics() {
  const key = String(config.apiKey || '');
  const parts = key.split('.');
  const isJwt = parts.length === 3 && parts.every((p) => p.length > 0);
  let role = null;
  let issuer = null;
  if (isJwt) {
    try {
      const payload = JSON.parse(
        Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
      );
      issuer = payload?.iss ?? null;
      // `sub` is an object in some tokens and a JSON-encoded string in others.
      let sub = payload?.sub;
      if (typeof sub === 'string') {
        try { sub = JSON.parse(sub); } catch { sub = null; }
      }
      role = sub?.role ?? payload?.role ?? null;
    } catch { /* not a decodable JWT — fall through as a plain key */ }
  }

  const totpConfigured = Boolean(config.totpSecret && config.totpToken);

  return {
    keyPresent: Boolean(key),
    keyLength: key.length,
    secretPresent: Boolean(config.apiSecret),
    isJwt,
    role,
    issuer,
    // A token minted by the token endpoint carries role "auth-totp".
    looksLikeAccessToken: Boolean(role && /auth/i.test(role)),
    totpConfigured,
    // "Would this credential work right now?" The TOTP mint path sends
    // GROWW_TOTP_KEY and a generated code, so the type of GROWW_API_KEY is
    // irrelevant once TOTP is configured — it only matters to the approval
    // flow, which is the fallback. Without TOTP, a JWT here can never mint.
    valid: Boolean(key) && (!isJwt || totpConfigured),
  };
}

/** Turn any of Groww's envelope shapes into one message, or null. */
function extractErrorMessage(json) {
  if (!json) return null;
  return (
    json?.error?.message ||
    json?.errorMessage?.message ||
    json?.errorMessage ||
    json?.message ||
    json?.error_message ||
    null
  );
}

function wrongCredentialError(diag, status) {
  return new GrowwApiError(
    `Groww rejected the credential (HTTP ${status}). ` +
    `GROWW_API_KEY looks like an ACCESS TOKEN (JWT, role "${diag.role}", issuer "${diag.issuer}"), ` +
    `not an API key — access tokens expire daily and cannot mint new ones. ` +
    `Generate a fresh API key at https://groww.in/trade-api/api-keys, put it in server/.env as ` +
    `GROWW_API_KEY (leaving GROWW_API_SECRET as-is), then restart the server. ` +
    `To stop this recurring, also set GROWW_TOTP_SECRET so the token refreshes itself.`,
    { status, code: 'WRONG_CREDENTIAL_TYPE', path: '/token/api/access' },
  );
}

function parseExpiry(expiry) {
  if (!expiry) return Date.now() + 6 * 60 * 60 * 1000;
  // Groww returns IST wall-clock without a zone, e.g. "2026-10-18T06:00:00".
  const parsed = Date.parse(expiry.length === 19 ? `${expiry}+05:30` : expiry);
  if (Number.isNaN(parsed)) return Date.now() + 6 * 60 * 60 * 1000;
  // Refresh 5 minutes early so a request never rides an expiring token.
  return parsed - 5 * 60 * 1000;
}

/** Extract expiry (epoch ms) from a Groww access-token JWT. */
function jwtExpiryMs(jwt) {
  try {
    const parts = String(jwt).split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const exp = Number(payload?.exp);
    if (!exp || Number.isNaN(exp)) return null;
    // Groww JWTs carry exp in seconds.
    return exp * 1000;
  } catch {
    return null;
  }
}

async function mintToken() {
  assertCredentials();

  // Pre-existing access token — skip the mint entirely.
  if (config.accessToken) {
    const expMs = jwtExpiryMs(config.accessToken);
    if (expMs && expMs > Date.now()) {
      tokenState = {
        token: config.accessToken,
        expiresAt: expMs - 5 * 60 * 1000,
        sessionName: null,
        tokenRefId: null,
        active: true,
        lastError: null,
      };
      return tokenState;
    }
    // Token present but expired — fall through to mint.
  }

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
      const msg = extractErrorMessage(json) || `TOTP token request failed (HTTP ${res.status})`;
      const diag = credentialDiagnostics();
      // Only blame GROWW_API_KEY when it is actually on the mint path. Inside
      // the TOTP branch the credential in play is GROWW_TOTP_KEY, so a 401
      // here means a bad TOTP secret/key, not a wrong API key.
      throw diag.looksLikeAccessToken && res.status === 401 && !diag.totpConfigured
        ? wrongCredentialError(diag, res.status)
        : new GrowwApiError(msg, { status: res.status, path: '/token/api/access' });
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
    const msg = extractErrorMessage(json) || `Token request failed (HTTP ${res.status})`;
    const diag = credentialDiagnostics();
    if (diag.looksLikeAccessToken && res.status === 401) throw wrongCredentialError(diag, res.status);
    throw new GrowwApiError(msg, {
      status: res.status,
      code: json?.error?.code ?? json?.errorCode ?? null,
      path: '/token/api/access',
    });
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
  inFlight = mintToken()
    .then((t) => {
      tokenState.lastError = null;
      clearGrowwHoldback();
      return t;
    })
    .catch((e) => {
      tokenState.lastError = e.message;
      noteGrowwFailure(e);
      throw e;
    })
    .finally(() => {
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

/**
 * One-shot report the engine and the UI can show: is there a usable token, and
 * if not, what exactly is wrong with the credential. This is what turns
 * "the bot is doing nothing" into an actionable line of text.
 */
export function growwHealth() {
  const diag = credentialDiagnostics();
  const token = tokenInfo();
  const problems = [];

  if (!diag.keyPresent) problems.push('GROWW_API_KEY is not set in server/.env');
  if (!diag.secretPresent) problems.push('GROWW_API_SECRET is not set in server/.env');
  // A JWT in GROWW_API_KEY only blocks the approval flow. With TOTP configured
  // the mint uses GROWW_TOTP_KEY, so flagging it here would report a broken
  // credential while the token is minting fine.
  if (diag.looksLikeAccessToken && !diag.totpConfigured) {
    problems.push(
      `GROWW_API_KEY is an ACCESS TOKEN (JWT role "${diag.role}"), not an API key. ` +
      `Generate a fresh API key at https://groww.in/trade-api/api-keys and set it as GROWW_API_KEY.`,
    );
  } else if (diag.keyPresent && !token.valid) {
    problems.push('No valid access token — the API key has not been exchanged yet.');
  }
  if (!diag.totpConfigured) {
    problems.push('GROWW_TOTP_SECRET is unset, so the token must be re-approved manually every day.');
  }
  if (tokenState.lastError) {
    problems.push(`Last token attempt failed: ${tokenState.lastError}`);
  }

  return {
    ok: diag.valid && token.valid && !tokenState.lastError,
    tokenValid: token.valid,
    tokenExpiresAt: token.expiresAt,
    credential: diag,
    lastError: tokenState.lastError,
    problems,
  };
}

/* ---------------------------------------------------------------------------
 * Groww hold-back.
 *
 * Groww is the fallback chain source. When its credential is known-broken, or
 * it has just rejected us, every Fyers miss would otherwise still pay for a
 * Groww round trip that cannot succeed — so hold it back for a while.
 * ------------------------------------------------------------------------- */

const GROWW_HOLDBACK_MS = 10 * 60_000;
let growwHeldBackUntil = 0;
let growwHeldBackReason = null;

export function growwHeldBack() {
  if (Date.now() < growwHeldBackUntil) return true;
  // A JWT in GROWW_API_KEY can never mint a token through the approval flow.
  // With TOTP configured the mint path does not touch it at all, so holding
  // Groww back would needlessly remove the working chain source.
  const diag = credentialDiagnostics();
  return diag.looksLikeAccessToken && !diag.totpConfigured;
}

export function growwHoldbackReason() {
  const diag = credentialDiagnostics();
  if (diag.looksLikeAccessToken && !diag.totpConfigured) {
    return 'GROWW_API_KEY is an access token, not an API key';
  }
  return growwHeldBackReason;
}

export function growwHoldbackStatus() {
  return {
    heldBack: growwHeldBack(),
    until: growwHeldBackUntil ? new Date(growwHeldBackUntil).toISOString() : null,
    reason: growwHoldbackReason(),
  };
}

/** Record a Groww failure. A rejected credential earns a long hold-back. */
export function noteGrowwFailure(e) {
  const status = Number(e?.status || 0);
  if (status === 401 || status === 403) {
    growwHeldBackUntil = Date.now() + GROWW_HOLDBACK_MS;
    growwHeldBackReason = e?.message || `HTTP ${status}`;
    return true;
  }
  return false;
}

/** Clear the hold-back — call when credentials are known good again. */
export function clearGrowwHoldback() {
  growwHeldBackUntil = 0;
  growwHeldBackReason = null;
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
