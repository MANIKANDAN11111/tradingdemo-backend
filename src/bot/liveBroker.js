import { config } from '../config.js';
import { request, groww } from '../growwClient.js';
import { fyers, fyersHealth } from '../fyersClient.js';
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

/**
 * Which broker executes live orders: 'fyers' | 'groww'.
 *
 * `auto` (the default) uses whichever broker is actually verified against its
 * own API right now. This matters because a broker's local token record can
 * claim to be valid while the broker has already revoked it — Groww's access
 * token and Fyers' refresh grant are both single-day credentials, so "configured"
 * is not the same as "working".
 *
 * Set LIVE_BROKER in server/.env to pin one explicitly.
 */
export function liveBrokerName() {
  const pinned = String(config.liveBroker || 'auto').toLowerCase();
  if (pinned === 'fyers' || pinned === 'groww') return pinned;
  return fyersHealth().ok ? 'fyers' : 'groww';
}

export function liveBrokerStatus() {
  const reasons = [];
  if (!LIVE_ENABLED) reasons.push('LIVE_TRADING_ENABLED is not set in server/.env');
  if (!config.apiKey) reasons.push('GROWW_API_KEY is missing');
  return {
    enabled: LIVE_ENABLED && Boolean(config.apiKey),
    liveFlagSet: LIVE_ENABLED,
    broker: liveBrokerName(),
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

/**
 * Buying power, in rupees, from the broker that will actually take the order.
 *
 * Groww reports `clear_cash`; Fyers returns a `fund_limit` list of
 * `{ title, amount }` rows, where the usable figure is the "Available Balance"
 * entry.
 */
async function availableCash(broker) {
  if (broker === 'fyers') {
    const funds = await fyers.funds();
    const list = Array.isArray(funds) ? funds : [];
    const avail = list.find((f) => /available/i.test(String(f?.title || f?.name || ''))) || list[0];
    return Number(avail?.amount ?? 0);
  }
  const margins = await groww.margins();
  return Number(margins?.clear_cash ?? 0);
}

async function preflight({ state, price, quantity, sector, broker }) {
  if (!LIVE_ENABLED) {
    throw new Error('Live trading is disabled. Set LIVE_TRADING_ENABLED=true in server/.env to arm it.');
  }
  if (!state.armed) throw new Error('Live trading is not armed.');
  if (!state.running) throw new Error('Bot is not running.');
  if (!marketOpen()) throw new Error('Outside market hours — refusing to place a live order.');

  const cash = await availableCash(broker);
  if (cash <= 0) {
    throw new Error(`${broker === 'fyers' ? 'Fyers' : 'Groww'} reports ₹0 available balance — live orders would be rejected.`);
  }

  const pnl = await dailyPnl(state.mode);
  if (pnl <= -state.capital * 0.05) {
    throw new Error(`Daily loss guard tripped (${pnl.toFixed(0)}). Live orders blocked.`);
  }

  const exposure = await sectorExposure(state.mode, state.capital);
  const pct = exposure[sector]?.pct ?? 0;
  if (pct >= 25) throw new Error(`Sector "${sector}" exposure at ${pct.toFixed(1)}% — live orders blocked.`);

  return { cash };
}

/** Fyers v3 order fields. `type` 2 = market, `side` 1 = buy / -1 = sell. */
export function fyersOrderBody({ symbol, side, quantity }) {
  return {
    symbol,
    qty: Math.abs(quantity),
    type: 2,
    side: String(side).toUpperCase() === 'BUY' ? 1 : -1,
    productType: 'INTRADAY',
    limitPrice: 0,
    stopPrice: 0,
    disclosedQty: 0,
    validity: 'DAY',
    offlineOrder: false,
    stopLoss: 0,
    takeProfit: 0,
  };
}

/**
 * Place a real order through the selected broker.
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
  const broker = liveBrokerName();
  const pre = await preflight({ state, price, quantity, sector, broker });

  let brokerOrderId = null;
  try {
    if (broker === 'fyers') {
      const res = await fyers.placeOrder(fyersOrderBody({ symbol, side, quantity }));
      brokerOrderId = res?.orderId ?? null;
      if (!brokerOrderId) {
        throw new Error(`Fyers accepted the request but returned no order id (code ${res?.code}: ${res?.message}).`);
      }
    } else {
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
      const res = await request('/order/place', { method: 'POST', body });
      brokerOrderId = res?.payload?.order_id ?? res?.order_id ?? null;
    }
  } catch (e) {
    throw new Error(`${broker === 'fyers' ? 'Fyers' : 'Groww'} rejected the live order: ${e?.message || e}`);
  }

  return { brokerOrderId, fillPrice: price, cash: pre.cash, reason, broker };
}
