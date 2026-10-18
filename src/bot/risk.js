import { getOpenPositions, getTodayRealised } from './store.js';

/**
 * Risk gate. Every entry passes through `checkEntry` before an order is
 * written; nothing else in the engine is allowed to place an order directly.
 *
 * Three independent limits:
 *   1. daily loss   — halts the whole bot for the session
 *   2. per trade    — caps how much one position may lose
 *   3. sector       — the "industry risk factor": max % of capital per sector
 */

export class RiskError extends Error {}

export async function dailyPnl(mode) {
  return getTodayRealised(mode);
}

export async function sectorExposure(mode, capital) {
  const open = await getOpenPositions(mode);
  const bySector = {};
  for (const p of open) {
    const notional = Number(p.avg_price) * Math.abs(Number(p.quantity));
    const sector = p.sector || 'Unclassified';
    bySector[sector] = (bySector[sector] || 0) + notional;
  }
  const out = {};
  for (const [sector, notional] of Object.entries(bySector)) {
    out[sector] = {
      notional,
      pct: capital > 0 ? (notional / capital) * 100 : 0,
    };
  }
  return out;
}

/** How much can this sector still take before it breaches the cap? */
export async function sectorHeadroom(mode, capital, sector, settings) {
  const exposure = await sectorExposure(mode, capital);
  const cap = (settings.maxSectorExposurePct / 100) * capital;
  const used = exposure[sector]?.notional || 0;
  return Math.max(0, cap - used);
}

/**
 * Position size from capital-per-trade. For options one lot is the minimum
 * tradable unit, so we never return less than the strategy's own quantity.
 */
export function positionSize({ strategy, settings, price }) {
  const perTrade = strategy.risk?.capitalPerTrade ?? settings.defaultCapitalPerTrade;
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return strategy.entry.quantity;
  const byCapital = Math.floor(perTrade / p);
  // Round down to the strategy's lot size, never below one lot.
  const lot = Math.max(1, strategy.entry.quantity);
  const lots = Math.max(1, Math.floor(byCapital / lot));
  return lots * lot;
}

export async function checkEntry({ strategy, settings, mode, price, quantity, capital, sector, tradesToday }) {
  const pnl = await dailyPnl(mode);
  if (pnl <= -Math.abs(settings.maxLossPerDay)) {
    return {
      ok: false,
      halt: true,
      reason: `Daily loss limit hit (${pnl.toFixed(2)} vs -${settings.maxLossPerDay}). Bot halted for the day.`,
    };
  }

  const maxTrades = strategy.risk?.maxTradesPerDay ?? 3;
  if (tradesToday >= maxTrades) {
    return { ok: false, reason: `Strategy already took ${tradesToday}/${maxTrades} trades today.` };
  }

  const notional = Number(price) * Math.abs(quantity);
  if (notional > capital) {
    return { ok: false, reason: `Order notional ${notional.toFixed(0)} exceeds capital ${capital}.` };
  }

  const headroom = await sectorHeadroom(mode, capital, sector, settings);
  if (notional > headroom) {
    const cap = settings.maxSectorExposurePct;
    return {
      ok: false,
      reason: `Sector "${sector}" would exceed the ${cap}% exposure cap ` +
        `(headroom ${headroom.toFixed(0)}, order ${notional.toFixed(0)}).`,
    };
  }

  return { ok: true };
}

/**
 * Stop-loss and target levels for a new position.
 * `type: 'percent'` is relative to entry; `type: 'points'` is absolute.
 */
export function exitLevels({ side, entryPrice, exit }) {
  const price = Number(entryPrice);
  const dir = side === 'SELL' ? -1 : 1;

  // The stop sits against the trade; the target sits with it.
  const stopLoss = exit?.stopLoss
    ? (exit.stopLoss.type === 'points'
      ? price - dir * Number(exit.stopLoss.value)
      : price * (1 - dir * (Number(exit.stopLoss.value) / 100)))
    : null;

  const target = exit?.target
    ? (exit.target.type === 'points'
      ? price + dir * Number(exit.target.value)
      : price * (1 + dir * (Number(exit.target.value) / 100)))
    : null;

  return { stopLoss, target };
}

/** Has an open position hit its stop, target, or the time exit? */
export function exitReasonFor({ position, ltp, now = new Date(), timeExit }) {
  const price = Number(ltp);
  const entry = Number(position.avg_price);
  const long = position.side === 'BUY';

  if (position.stop_loss != null) {
    const sl = Number(position.stop_loss);
    if (long ? price <= sl : price >= sl) return { reason: 'stop-loss', price };
  }
  if (position.target != null) {
    const t = Number(position.target);
    if (long ? price >= t : price <= t) return { reason: 'target', price };
  }
  if (timeExit) {
    const ist = new Date(now.getTime() + 5.5 * 3600_000);
    const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const [h, m] = String(timeExit).split(':').map(Number);
    if (minutes >= h * 60 + (m || 0)) return { reason: 'time-exit', price };
  }
  return null;
}

/** Realised P&L for closing a position, including charges. */
export function realisedPnl({ side, quantity, entryPrice, exitPrice, charges = 0 }) {
  const dir = side === 'SELL' ? -1 : 1;
  const gross = (Number(exitPrice) - Number(entryPrice)) * dir * Math.abs(Number(quantity));
  return gross - Number(charges);
}
