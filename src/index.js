import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { GrowwApiError, getToken, tokenInfo } from './growwClient.js';
import { CoinSwitchApiError } from './coinSwitchClient.js';
import { cacheStats } from './cache.js';

import authRoutes from './routes/auth.js';
import portfolioRoutes from './routes/portfolio.js';
import orderRoutes from './routes/orders.js';
import marketRoutes from './routes/market.js';
import dashboardRoutes from './routes/dashboard.js';
import coinRoutes from './routes/coin.js';
import { coinSwitchPublicKey } from './coinSwitchClient.js';
import { initDb } from './db.js';
import { ensureLocalPostgres } from './localPg.js';
import userRoutes from './routes/users.js';
import botRoutes from './routes/bot.js';
import botAnalyticsRoutes from './routes/botAnalytics.js';
import fyersAuthRoutes from './routes/fyersAuth.js';
import { initBotSchema } from './bot/schema.js';
import { start as startEngine, status as engineStatus } from './bot/engine.js';
import { liveBrokerStatus } from './bot/liveBroker.js';
import brokerRoutes from './routes/brokers.js';
import { initBrokersTable } from './brokerStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Lightweight request log
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
    }
  });
  next();
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: "esakki-pandi-backend",
    broker: 'Groww',
    uptimeSeconds: Math.round(process.uptime()),
    auth: tokenInfo(),
    coinSwitch: {
      configured: Boolean(config.coinSwitchSecret),
      apiKey: config.coinSwitchSecret ? coinSwitchPublicKey() : null,
    },
    cache: cacheStats(),
    bot: { live: liveBrokerStatus() },
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/coin', coinRoutes);
app.use('/api/users', userRoutes);
app.use('/api/bot', botRoutes);
app.use('/api/bot', botAnalyticsRoutes);
app.use('/api/fyers', fyersAuthRoutes);
app.use('/api/brokers', brokerRoutes);

// Serve the built frontend when it exists (npm run build in the project root).
const distDir = path.resolve(__dirname, '..', '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `No route for ${req.method} ${req.path}` });
});

// Error handler — surfaces upstream failures with their real status/code.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const isUpstream = err instanceof GrowwApiError || err instanceof CoinSwitchApiError;
  const status = isUpstream ? (err.status >= 400 && err.status < 600 ? err.status : 502) : 500;
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err.message);
  res.status(status).json({
    ok: false,
    error: err.message || 'Internal server error',
    code: isUpstream ? err.code || null : null,
    path: isUpstream ? err.path || null : null,
  });
});

// A bug in one handler must never take the whole API down.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

app.listen(config.port, () => {
  console.log(`Pandi's Friend backend listening on http://localhost:${config.port}`);

  // Make sure the private PostgreSQL cluster is up before touching the DB.
  const pg = ensureLocalPostgres();
  console.log(`[db] local postgres: ${pg.started ? 'started' : 'not started'} (${pg.reason})`);

  // Create the users table and seed the default account (PostgreSQL).
  initDb()
    .then((seeded) => {
      if (seeded) {
        console.log(`[db] PostgreSQL ready — seeded default user "${seeded.username}" (password: ${seeded.password})`);
      } else {
        console.log('[db] PostgreSQL ready');
      }
    })
    .catch((e) => console.error(`[db] PostgreSQL init failed: ${e.message}`));

  // Create the bot's tables alongside the user store, then resume the engine
  // if it was left running. Without the resume, a restart leaves the bot
  // reporting "running" in the database with no tick loop behind it.
  initBrokersTable()
    .then(() => console.log('[db] brokers table ready'))
    .catch((e) => console.error(`[db] brokers table init failed: ${e.message}`));

  initBotSchema()
    .then(async () => {
      console.log('[db] bot tables ready');
      try {
        const st = await engineStatus();
        // Auto-start on boot unless the bot was explicitly halted for the day.
        // This used to be two competing blocks, the second of which started the
        // engine unconditionally — so "stop" silently did not survive a restart.
        if (st?.haltedReason) {
          console.log(`[bot] engine not auto-started — halted: ${st.haltedReason}`);
        } else {
          const res = await startEngine();
          console.log(`[bot] engine auto-started: ${res?.ok ? 'ticking' : res?.reason}`);
        }
      } catch (e) {
        console.error(`[bot] engine resume failed: ${e.message}`);
      }
    })
    .catch((e) => console.error(`[db] bot schema init failed: ${e.message}`));

  // Groww auto-refresh: mint a fresh token every 5 hours (TOTP never expires,
  // but the access token does). The getToken() call mints a new one automatically.
  const GROWW_REFRESH_INTERVAL = 5 * 60 * 60 * 1000; // 5 hours
  setInterval(async () => {
    try {
      const t = await getToken({ force: true });
      console.log(`[groww] token auto-refreshed, expires ${new Date(t.expiresAt).toISOString()}`);
    } catch (e) {
      console.warn(`[groww] auto-refresh failed: ${e.message}`);
    }
  }, GROWW_REFRESH_INTERVAL);

  // Warm the token so the first dashboard load is fast; failures are non-fatal.
  getToken()
    .then((t) => console.log(`Groww token ready — session "${t.sessionName}", expires ${new Date(t.expiresAt).toISOString()}`))
    .catch((e) => console.warn(`Groww token not available yet: ${e.message}`));

  // Fyers keep-alive: refresh proactively (before expiry) and retry with
  // backoff whenever a refresh fails, so the broker stays connected without
  // anyone manually re-authorizing.
  import('./fyersClient.js').then(({ refreshAccessToken, fyersTokenInfo }) => {
    const FYERS_REFRESH_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours
    let fyersTimer = null;
    let fyersBackoff = 5 * 60 * 1000; // 5 min after a failure, grows to 30 min
    const FYERS_MAX_BACKOFF = 30 * 60 * 1000;

    const tick = async () => {
      const info = fyersTokenInfo();
      if (!info.hasToken) {
        console.warn('[fyers] no token on disk — awaiting manual authorization');
        return;
      }
      // Only refresh when the token is close to expiry, or already expired.
      const msLeft = info.expiresAt ? new Date(info.expiresAt).getTime() - Date.now() : 0;
      if (msLeft > 2 * 60 * 60 * 1000) return; // plenty of life left

      try {
        const token = await refreshAccessToken();
        fyersBackoff = 5 * 60 * 1000;
        console.log(`[fyers] access token auto-refreshed, expires ${new Date(token.expiresAt).toISOString()}`);
      } catch (e) {
        console.warn(`[fyers] refresh failed, retrying in ${Math.round(fyersBackoff / 60000)} min: ${e.message}`);
        clearTimeout(fyersTimer);
        fyersTimer = setTimeout(tick, fyersBackoff);
        fyersBackoff = Math.min(fyersBackoff * 2, FYERS_MAX_BACKOFF);
      }
    };

    // Also retry on 401 from any live call: the request helper forces a refresh,
    // so a transient failure self-heals on the next poll.
    fyersTimer = setTimeout(tick, 30 * 1000); // first check shortly after boot
    setInterval(tick, FYERS_REFRESH_INTERVAL);
    console.log('[fyers] auto-refresh loop armed');
  }).catch((e) => console.warn(`[fyers] auto-refresh setup failed: ${e.message}`));
});
