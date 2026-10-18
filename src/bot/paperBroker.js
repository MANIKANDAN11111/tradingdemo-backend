import { recordOrder, updateOrder, openPosition, closePosition, recordTrade, addDailyPnl } from './store.js';

/**
 * Paper broker. Fills at the live LTP plus slippage, so paper P&L tracks what
 * the live order would actually have made — including the charges you would
 * really pay. This is the default execution path and needs no credentials.
 *
 * Every order is written to the DB BEFORE it is "executed" so the audit trail
 * survives a crash.
 */

const DEFAULTS = {
  slippagePct: 0.05,
  brokerageCap: 20,        // flat, per executed order
  brokerageRate: 0.0003,   // or a rate if the cap doesn't apply
  exchangeRate: 0.0005,    // exchange transaction charge
  sttRate: 0.0002,         // securities transaction tax, sell side
  gstRate: 0.18,           // on brokerage + exchange
  sebiRate: 0.000001,      // per unit turnover
  stampRate: 0.00003,      // buy side only
};

export function estimateCharges({ side, price, quantity, overrides = {} }) {
  const o = { ...DEFAULTS, ...overrides };
  const turnover = Number(price) * Math.abs(Number(quantity));

  const brokerage = Math.min(o.brokerageCap, turnover * o.brokerageRate);
  const exchange = turnover * o.exchangeRate;
  const stt = side === 'SELL' ? turnover * o.sttRate : 0;
  const stamp = side === 'BUY' ? turnover * o.stampRate : 0;
  const sebi = turnover * o.sebiRate;
  const gst = (brokerage + exchange) * o.gstRate;

  const total = brokerage + exchange + stt + stamp + sebi + gst;
  return {
    turnover,
    brokerage: round2(brokerage),
    exchange: round2(exchange),
    stt: round2(stt),
    stamp: round2(stamp),
    sebi: round2(sebi),
    gst: round2(gst),
    total: round2(total),
  };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** The price a paper order would actually get: LTP plus slippage, always
 *  against the trader. */
export function fillPrice({ side, price, slippagePct = DEFAULTS.slippagePct }) {
  const p = Number(price);
  const slip = (p * Number(slippagePct)) / 100;
  return side === 'BUY' ? p + slip : p - slip;
}

/**
 * Simulate a fill and record everything. Returns the order row.
 * `charges` may be pre-computed (from the risk check) or omitted.
 */
export async function placePaperOrder({
  strategyId,
  symbol,
  exchange = 'NSE',
  segment = 'FNO',
  side,
  quantity,
  price,
  reason = 'entry',
  settings = {},
}) {
  const slippage = settings.slippagePct ?? DEFAULTS.slippagePct;
  const filled = fillPrice({ side, price, slippagePct: slippage });
  const charges = estimateCharges({ side, price: filled, quantity });

  const orderId = await recordOrder({
    strategyId,
    mode: 'paper',
    symbol,
    exchange,
    segment,
    side,
    quantity: Math.abs(quantity),
    orderType: 'MARKET',
    limitPrice: null,
    status: 'FILLED',
    fillPrice: round2(filled),
    charges: charges.total,
    reason: `${reason} @ ${round2(filled)}`,
  });

  return {
    id: orderId,
    strategyId,
    mode: 'paper',
    symbol,
    side,
    quantity: Math.abs(quantity),
    price: round2(filled),
    charges: charges.total,
    reason,
  };
}

/** Open a paper position in the book. */
export async function openPaperPosition({ strategy, order, sector }) {
  return openPosition({
    strategyId: strategy.id,
    mode: 'paper',
    symbol: order.symbol,
    exchange: order.exchange,
    segment: order.segment,
    side: order.side,
    quantity: order.quantity,
    avgPrice: order.price,
    stopLoss: strategy.stopLoss ?? null,
    target: strategy.target ?? null,
    sector,
  });
}

/** Close a paper position and book the round trip. */
export async function closePaperPosition({ position, exitPrice, reason, charges }) {
  const realised = realisedGross({ side: position.side, quantity: position.quantity, entryPrice: position.avg_price, exitPrice }) - Number(charges);
  await closePosition(position.id, { exitPrice, realisedPnl: realised });
  await recordTrade({
    positionId: position.id,
    strategyId: position.strategy_id,
    mode: position.mode,
    symbol: position.symbol,
    side: position.side,
    quantity: position.quantity,
    entryPrice: position.avg_price,
    exitPrice,
    charges: Number(charges),
    pnl: realised,
    exitReason: reason,
    openedAt: position.opened_at,
  });
  const day = new Date().toISOString().slice(0, 10);
  await addDailyPnl(day, position.mode, realised, 1);
  return realised;
}

export function realisedGross({ side, quantity, entryPrice, exitPrice }) {
  const dir = side === 'SELL' ? -1 : 1;
  return (Number(exitPrice) - Number(entryPrice)) * dir * Math.abs(Number(quantity));
}
