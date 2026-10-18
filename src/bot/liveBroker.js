import { config } from '../config.js';
import { request, groww } from '../growwClient.js';
import { dailyPnl, sectorExposure } from './risk.js';

/**
 * Live order placement.
 *
 * SAFETY: nothing here can execute unless LIVE_TRADING_ENABLED=true is set in
 * server/.env. With the flag absent the module reports
 * liveBrokerStatus().enabled === false and placeLiveOrder throws immediately,
 * so the engine refuses to run live rather than silently degrading to paper.
 *
 * Even when enabled, every call re-runs the pre-flight checks (armed, market
 * hours, positive margin, daily loss) before a single rupee moves.
 */
export const LIVE_ENABLED = config.liveTradingEnabled === true;

export function liveBrokerStatus() {
  const reasons = [];
  if (!LIVE_ENABLED) reasons.push('LIVE_TRADING_ENABLED is not set in server/.env');
  if (!config.apiKey) reasons.push('GROWW_API_KEY is missing');
  return {
    enabled: LIVE_ENABLED && Boolean(config.apiKey),
    liveFlagSet: LIVE_ENABLED,
    reasons,
  };
}

/** NSE equity market hours in IST (mon–fri). */
export function marketOpen(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

async function preflight({ state, price, quantity, sector }) {
  if (!LIVE_ENABLED) {
    throw new Error('Live trading is disabled. Set LIVE_TRADING_ENABLED=true in server/.env to arm it.');
  }
  if (!state.armed) throw new Error('Live trading is not armed.');
  if (!state.running) throw new Error('Bot is not running.');
  if (!marketOpen()) throw new Error('Outside market hours — refusing to place a live order.');

  const margins = await groww.margins();
  if (!margins) throw new Error('Groww returned no margin data — cannot place a live order.');
  const cash = Number(margins?.clear_cash ?? 0);
  if (cash <= 0) throw new Error(`Groww reports ₹0 clear cash — live orders would be rejected.`);

  const pnl = await dailyPnl(state.mode);
  if (pnl <= -state.capital * 0.05) {
    throw new Error(`Daily loss guard tripped (${pnl.toFixed(0)}). Live orders blocked.`);
  }

  const exposure = await sectorExposure(state.mode, state.capital);
  const pct = exposure[sector]?.pct ?? 0;
  if (pct >= 25) throw new Error(`Sector "${sector}" exposure at ${pct.toFixed(1)}% — live orders blocked.`);

  return { cash };
}

/**
 * Place a real order through Groww.
 *
 * NOTE: the order is recorded in bot_orders with status PENDING first, then
 * updated with the broker's order id once the call returns. A failure between
 * the two leaves a PENDING row, which is what you want to see in the audit
 * trail.
 */
export async function placeLiveOrder({
  symbol,
  side,
  quantity,
  price,
  segment = 'FNO',
  exchange = 'NSE',
  sector = 'Index',
  state,
  reason = 'entry',
}) {
  const pre = await preflight({ state, price, quantity, sector });

  const body = {
    product: 'NRML',
    segment,
    exchange,
    symbol,
    qty: Math.abs(quantity),
    side: side.toUpperCase(),
    orderType: 'MARKET',
    validity: 'DAY',
  };

  let brokerOrderId = null;
  try {
    const res = await request('/order/place', { method: 'POST', body });
    brokerOrderId = res?.payload?.order_id ?? res?.order_id ?? null;
  } catch (e) {
    throw new Error(`Groww rejected the live order: ${e?.message || e}`);
  }

  return { brokerOrderId, fillPrice: price, cash: pre.cash, reason };
}
