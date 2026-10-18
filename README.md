# Pandi's Friend — Backend

Node.js (Express) backend that talks to the **Groww Trading API** and feeds the React dashboard in `../src`.

## Quick start

```bash
cd server
cp .env.example .env     # then paste your Groww API key + secret
npm install
npm start                # http://localhost:5000
```

Frontend (dev, with proxy):

```bash
cd ..
npm run dev              # http://localhost:5173  →  /api proxied to :5000
```

Production (one server for both):

```bash
npm run build            # in the project root, outputs ../dist
cd server && npm start   # :5000 now serves the SPA and the API
```

## Authentication

The key + secret flow from the Groww docs, `key_type: "approval"`:

```
checksum = SHA256(api_secret + timestamp)     # timestamp = epoch seconds
POST https://api.groww.in/v1/token/api/access
Authorization: Bearer <API_KEY>
{ "key_type": "approval", "checksum": "<checksum>", "timestamp": "<epoch>" }
```

Notes:

- Access tokens expire **daily at 06:00 IST**. `growwClient.js` caches the token
  in memory, refreshes it 5 minutes early, single-flights concurrent refreshes,
  and retries once with a fresh token on any `401`.
- The approval flow may require approving the request on the
  [Groww Cloud API Keys page](https://groww.in/trade-api/api-keys) each day.
- The API key carries a source-IP allow-list. If calls start failing after a
  network change, update the static IP on that page.
- The official `growwapi` npm SDK assumes a **TOTP** secret (base32) for auth and
  cannot be used with an approval-style secret — this backend implements the
  checksum flow directly instead.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Service + token + cache state |
| GET | `/api/auth/status` | Token validity (never returns the token) |
| POST | `/api/auth/refresh` | Force a new token |
| POST | `/api/auth/login` | Verify username + password against PostgreSQL, issue a session token |
| POST | `/api/auth/register` | Create a user account |
| GET | `/api/auth/verify` | Validate a session token |
| POST | `/api/auth/logout` | Revoke a session token |
| GET | `/api/users` | List user accounts (never returns hashes) |
| DELETE | `/api/users/:id` | Remove a user account |
| GET | `/api/dashboard` | **Aggregate** — auth, indices, funds, positions, holdings, orders |
| GET | `/api/portfolio/holdings` | Equity holdings |
| GET | `/api/portfolio/positions?segment=CASH\|FNO` | Positions |
| GET | `/api/portfolio/margins` | Full margin detail |
| GET | `/api/portfolio/summary` | Margins + holdings + both position books |
| POST | `/api/portfolio/refresh` | Drop cached portfolio data |
| GET | `/api/orders?segment=CASH&page=0&pageSize=50` | Order list (normalised) |
| GET | `/api/orders/:orderId?segment=` | Order detail |
| GET | `/api/orders/:orderId/trades?segment=` | Trades for an order |
| GET | `/api/market/indices` | NIFTY, SENSEX, BANKNIFTY, FINNIFTY, MIDCPNIFTY with day change |
| GET | `/api/market/ltp?symbols=NSE_NIFTY,BSE_SENSEX&segment=CASH` | Last traded price |
| GET | `/api/market/quote?exchange=NSE&symbol=RELIANCE&segment=CASH` | Full quote (OHLC, circuits, depth) |
| GET | `/api/market/ohlc?symbols=NSE_RELIANCE&segment=CASH` | OHLC |
| GET | `/api/coin/status` | CoinSwitch key validation + derived public key |
| GET | `/api/coin/dashboard` | **Aggregate** — top pairs, order book, recent trades |
| GET | `/api/coin/tickers?exchange=coinswitchx&symbol=BTC/INR` | 24hr stats (all pairs, or one) |
| GET | `/api/coin/depth?exchange=coinswitchx&symbol=BTC/INR` | Order book |
| GET | `/api/coin/candles?exchange=&symbol=&interval=60&hours=24` | OHLCV candles |
| GET | `/api/coin/trades?exchange=coinswitchx&symbol=BTC/INR` | Recent public trades |

### Symbol format

LTP / OHLC take `EXCHANGE_SYMBOL` values, comma-separated:

- `NSE_RELIANCE`, `BSE_SENSEX`
- Indices: `NSE_NIFTY`, `NSE_BANKNIFTY`, `NSE_FINNIFTY`, `NSE_MIDCPNIFTY`, `BSE_SENSEX`
- Options: `NSE_NIFTY26O1922700PE` (with `segment=FNO`)

The LTP response is a map keyed by the symbol you asked for, so it is
deliberately **not** camel-cased.

## CoinSwitch PRO (crypto)

Base URL `https://coinswitch.co`, paths under `/trade/api/v2`. Auth is
**Ed25519 request signing** — no token, no session:

```
signed_message = METHOD + path_with_query + epoch     # epoch = Unix MILLISECONDS
X-AUTH-APIKEY    = Ed25519 public key (hex)
X-AUTH-SIGNATURE = Ed25519 sign(signed_message) (hex)
X-AUTH-EPOCH     = the same epoch string
```

The path is URL-**decoded** before signing (`%2F` → `/`), per the docs.

### The public key is derived — this is the #1 gotcha

CoinSwitch calls the 64-char hex value in your profile the "API key", but it is
the **public** key. The value you are given to *sign with* is the **secret**
(32-byte Ed25519 seed). If you paste the secret into `X-AUTH-APIKEY` you get
`401 Invalid access`. Derive the public key instead:

```js
const pkcs8 = crypto.createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(secret, 'hex')]),
  format: 'der', type: 'pkcs8',
});
const apiKey = Buffer.from(crypto.createPublicKey(pkcs8).export({ format: 'jwk' }).x, 'base64url').toString('hex');
```

`coinSwitchClient.js` does this at startup from `COINSWITCH_SECRET`.

### What this key can reach

Verified against the live API:

| Endpoint | Result |
| --- | --- |
| `GET /24hr/all-pairs/ticker?exchange=` | 200 — 408 pairs, full 24hr stats |
| `GET /24hr/ticker?exchange=&symbol=` | 200 |
| `GET /depth?exchange=&symbol=` | 200 — order book |
| `GET /candles?exchange=&symbol=&interval=&start_time=&end_time=` | 200 — OHLCV |
| `GET /trades?exchange=&symbol=` | 200 — recent public trades |
| `GET /validate/keys` | 200 — `{"message":"Valid Access"}` |
| `GET /user/portfolio` | **401** — "Api Key and Secret Keys are not Valid or Expired" |
| `GET /orders?open=&exchanges=` | **401** — "Invalid access" |
| `GET /coins?exchange=` | **401** — "Invalid access" |
| `GET /tds`, `/tradingFee` | **401** — "API Key or Signature is not Correct" |

So this key is **market-data only**: tickers, depth, candles and trades work,
but account endpoints (portfolio, orders, coins, TDS, trading fee) are
rejected. To read account data, regenerate the key pair in
[CoinSwitch PRO → API Trading](https://coinswitch.co/pro/profile?section=api-trading)
and make sure account access is enabled. The panel degrades gracefully — it
shows whatever the key can reach and reports per-endpoint errors.

Note the three *different* 401 messages: "Invalid access" (signature rejected),
"API Key or Signature is not Correct", and "not Valid or Expired" (signature
accepted, key not permitted for that endpoint). The message tells you which
layer failed.

## User store (PostgreSQL)

The login gate is backed by PostgreSQL. Two ways to provide it:

**A. Private cluster, no sudo (default here)**

```bash
bash server/scripts/setup-local-pg.sh        # create + start + provision
bash server/scripts/setup-local-pg.sh status # is it running?
bash server/scripts/setup-local-pg.sh stop   # shut it down
```

This runs a second PostgreSQL cluster owned by your user, with its data in
`server/pgdata/`, listening on **127.0.0.1:5433** so it never collides with a
system server on 5432. `src/localPg.js` auto-starts it on boot, so a reboot
needs no manual step.

**B. An existing server**

```bash
sudo -u postgres psql -c "CREATE USER tradingdemo WITH PASSWORD 'tradingdemo_pass';"
sudo -u postgres psql -c "CREATE DATABASE tradingdemo OWNER tradingdemo;"
```

then point `DATABASE_URL` at it.

### How accounts work

- `src/db.js` creates the `users` table on boot and seeds an `admin` account
  **only when the table is empty** — password from `ADMIN_PASSWORD` (default
  `admin123`).
- `src/password.js` hashes with **scrypt** (Node built-in, no bcrypt dependency):
  a random 16-byte salt per user, 64-byte derived key, compared with
  `timingSafeEqual`.
- Sessions are HMAC-signed tokens (`src/authSession.js`), not the password.
  Logout revokes them server-side.
- The login screen has an **Add User** tab (writes to the DB) and a
  **Database Users** panel (lists + deletes).

### Gotcha: Express 4 does not catch async rejections

A rejected promise inside an `async` route handler is **not** forwarded to the
error middleware in Express 4 — it becomes an unhandled rejection. The login
route wraps its DB call in try/catch and returns `503` with a readable message
when PostgreSQL is unreachable, instead of hanging or crashing.

## Design notes

- **snake_case → camelCase** at the route boundary (`src/util/case.js`), so the
  React code never sees Groww's wire format.
- **TTL cache** (`src/cache.js`) — 15–20s. Keeps us inside Groww's per-endpoint
  limits (~20 req/sec on holdings/positions/margins/orders, ~500/day).
  The cache returns values directly, never a spread copy, so arrays survive.
- **Partial failure** — `/api/dashboard` uses `Promise.allSettled`, so one dead
  endpoint reports into `errors[]` instead of blanking the page.
- **Crash guards** — `unhandledRejection` / `uncaughtException` are logged rather
  than killing the process.

## Security

`.env` holds the API key and secret and is gitignored. Nothing in this repo
should ever contain live credentials. If a key is ever exposed, revoke it at
<https://groww.in/trade-api/api-keys> and generate a new one.
