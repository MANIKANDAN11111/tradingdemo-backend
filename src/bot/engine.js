import { deepCamel } from '../util/case.js';
import { groww } from '../growwClient.js';
import { cached } from '../cache.js';
import {
  getState, setState, listStrategies, listTrades, getOpenPositions,
  getTodayRealised, recordEquity, recordOrder, updateOrder, openPosition,
  closePosition, recordTrade, addDailyPnl,
} from './store.js';
import { loadConfig, STRATEGIES_FILE, CONFIG_DIR } from './strategy.js';
import { buildContext, evaluateAll, explain, inWindow } from './signals.js';
import { checkEntry, positionSize, exitLevels, exitReasonFor } from './risk.js';
import { feed, resetAll } from './candles.js';
import { resolveInstrument, describeInstrument } from './resolver.js';
import { placePaperOrder, closePaperPosition, estimateCharges } from './paperBroker.js';
import { placeLiveOrder, liveBrokerStatus } from './liveBroker.js';
import { evaluateEsakky, esakkyDecision } from './esakkyStrategy.js';

/**
 * The bot engine. A single instance runs one evaluation loop:
 *
 *   tick → for each enabled strategy → resolve symbol → fetch LTP → feed candles
 *        → evaluate exits → evaluate entries → risk gate → execute
 *
 * Nothing outside this module may write to bot_orders or bot_positions.
 */

const TICK_MS = 2_000;      // poll upstream
const MAX_LOG = 200;

const runtime = {
  timer: null,
  config: null,
  symbols: new Map(),      // strategyId -> resolved instrument
  prevCtx: new Map(),      // strategyId -> previous context (for crosses)
  lastEval: new Map(),     // strategyId -> last confluence evaluation (for the UI)
  lastTick: null,
  ticks: 0,
  log: [],
};

/* ------------------------------------------------------------------ log --- */

function log(event, detail = null) {
  const entry = { time: new Date().toISOString(), event, detail };
  runtime.log.unshift(entry);
  if (runtime.log.length > MAX_LOG) runtime.log.pop();
  return entry;
}

/* ------------------------------------------------------------- config --- */

async function reloadConfig() {
  const cfg = await loadConfig();
  runtime.config = cfg;
  return cfg;
}

/* --------------------------------------------------- instrument lookup --- */

async function resolved(strategy, settings) {
  const cachedSymbol = runtime.symbols.get(strategy.id);
  if (cachedSymbol) return cachedSymbol;
  const inst = await resolveInstrument(strategy.instrument);
  runtime.symbols.set(strategy.id, inst);
  return inst;
}

async function fetchQuote(inst) {
  try {
    const raw = await cached(`bot:quote:${inst.exchange}:${inst.symbol}`, 2_000, () =>
      groww.quote({ exchange: inst.exchange, segment: inst.segment, tradingSymbol: inst.symbol }),
    );
    return deepCamel(raw);
  } catch {
    const ltpKey = `${inst.exchange}_${inst.symbol}`;
    const map = await cached(`bot:ltp:${ltpKey}`, 2_000, () => groww.ltp([ltpKey], inst.segment));
    const v = map?.[ltpKey];
    const ltp = typeof v === 'number' ? v : v?.lastPrice ?? v?.ltp ?? null;
    return ltp != null ? { lastPrice: ltp } : null;
  }
}

/* ------------------------------------------------------------- execute --- */

async function executeEntry({ strategy, inst, side, quantity, price, mode, settings, state }) {
  const sector = strategy.sector || inst.exchange;

  if (mode === 'live') {
    const res = await placeLiveOrder({
      symbol: inst.symbol, side, quantity, price,
      segment: inst.segment, exchange: inst.exchange, sector, state,
    });
    const id = await recordOrder({
      strategyId: strategy.id, mode, symbol: inst.symbol, exchange: inst.exchange,
      segment: inst.segment, side, quantity, orderType: 'MARKET', status: 'PENDING',
      brokerOrderId: res.brokerOrderId, reason: `entry (${describeInstrument(inst)})`,
    });
    await updateOrder(id, { status: 'FILLED', fillPrice: res.fillPrice, reason: `entry filled by Groww #${res.brokerOrderId}` });
    await openPosition({
      strategyId: strategy.id, mode, symbol: inst.symbol, exchange: inst.exchange,
      segment: inst.segment, side, quantity, avgPrice: res.fillPrice,
      stopLoss: strategy.stopLoss, target: strategy.target, sector,
    });
    return { id, brokerOrderId: res.brokerOrderId, price: res.fillPrice };
  }

  const order = await placePaperOrder({
    strategyId: strategy.id, symbol: inst.symbol, exchange: inst.exchange,
    segment: inst.segment, side, quantity, price, reason: `entry (${describeInstrument(inst)})`,
    settings,
  });
  await openPosition({
    strategyId: strategy.id, mode, symbol: inst.symbol, exchange: inst.exchange,
    segment: inst.segment, side, quantity, avgPrice: order.price,
    stopLoss: strategy.stopLoss, target: strategy.target, sector,
  });
  return { id: order.id, price: order.price, charges: order.charges };
}

async function executeExit({ strategy, position, exitPrice, reason, mode, settings, state }) {
  const sector = position.sector || 'Index';
  const closeSide = position.side === 'BUY' ? 'SELL' : 'BUY';

  if (mode === 'live') {
    const res = await placeLiveOrder({
      symbol: position.symbol, side: closeSide, quantity: position.quantity, price: exitPrice,
      segment: position.segment, exchange: position.exchange, sector, state,
      reason: `exit:${reason}`,
    });
    const id = await recordOrder({
      strategyId: strategy.id, mode, symbol: position.symbol, exchange: position.exchange,
      segment: position.segment, side: closeSide, quantity: position.quantity,
      orderType: 'MARKET', status: 'PENDING', brokerOrderId: res.brokerOrderId,
      reason: `exit ${reason} @ ${exitPrice}`,
    });
    await updateOrder(id, { status: 'FILLED', fillPrice: res.fillPrice, reason: `exit filled by Groww #${res.brokerOrderId}` });
    await paperClose(position, exitPrice, reason, 0);
    return { id, brokerOrderId: res.brokerOrderId };
  }

  const charges = estimateCharges({
    side: closeSide, price: exitPrice, quantity: position.quantity,
    overrides: { slippagePct: settings.slippagePct },
  });
  const realised = await paperClose(position, exitPrice, reason, charges.total);
  return { realised };
}

/** Shared book-keeping so both modes close the same way. */
async function paperClose(position, exitPrice, reason, charges) {
  const gross = (() => {
    const dir = position.side === 'SELL' ? -1 : 1;
    return (Number(exitPrice) - Number(position.avg_price)) * dir * Math.abs(Number(position.quantity));
  })();
  const realised = gross - Number(charges);
  await closePosition(position.id, { exitPrice, realisedPnl: realised });
  await recordTrade({
    positionId: position.id, strategyId: position.strategy_id, mode: position.mode,
    symbol: position.symbol, side: position.side, quantity: position.quantity,
    entryPrice: position.avg_price, exitPrice, charges: Number(charges), pnl: realised,
    exitReason: reason, openedAt: position.opened_at,
  });
  const day = new Date().toISOString().slice(0, 10);
  await addDailyPnl(day, position.mode, realised, 1);
  return realised;
}

/* ---------------------------------------------------------------- tick --- */

async function runStrategy(strategy, state, settings, mode) {
  const inst = await resolved(strategy, settings);
  if (!inst) return { skipped: 'unresolved symbol' };

  const q = await fetchQuote(inst);
  const ltp = Number(q?.lastPrice ?? inst.ltp ?? 0);
  if (!ltp) return { skipped: 'no LTP', symbol: inst.symbol };

  const candleMs = Number(strategy.entry.candleMinutes ?? 1) * 60_000;
  const candles = feed(
    `${strategy.id}:${inst.symbol}`,
    { price: ltp, volume: q?.volume },
    candleMs,
  );

  const ctx = buildContext({
    candles, ltp, prevClose: q?.ohlc?.prevClose ?? q?.prevClose, orbMinutes: 15,
  });
  const prev = runtime.prevCtx.get(strategy.id) || null;
  runtime.prevCtx.set(strategy.id, ctx);

  const closed = [];
  const open = (await getOpenPositions(mode)).filter((p) => p.strategy_id === strategy.id);
  for (const p of open) {
    const exit = exitReasonFor({ position: p, ltp, timeExit: strategy.exit.timeExit });
    if (exit) {
      const r = await executeExit({ strategy, position: p, exitPrice: exit.price, reason: exit.reason, mode, settings, state });
      closed.push({ symbol: p.symbol, reason: exit.reason, ...r });
    }
  }
  if (closed.length) return { closed };

  const stillOpen = (await getOpenPositions(mode)).some((p) => p.strategy_id === strategy.id);
  if (stillOpen) return { skipped: 'already in a position' };

  if (!inWindow(strategy.entry.window)) return { skipped: 'outside entry window' };

  // Esakky strategies use multi-timeframe confluence scoring. `inst` here is
  // the resolved ATM option, so the quote we already fetched is the option's
  // own premium — exactly what the option-premium factor needs.
  if (strategy.type === 'esakky') {
    const optionQuote = q
      ? { ltp: q.lastPrice ?? q.ltp ?? ltp, prevClose: q.ohlc?.prevClose ?? q.prevClose ?? null }
      : null;

    const capital = state.capital;
    const maxRiskPct = Number(strategy.esakky?.risk?.max_risk_per_trade_percent ?? 1);
    const lotSize = strategy.entry.quantity;

    // Capital and lot size go in, because the per-trade risk cap is part of
    // the fifth mandatory gate: a setup whose smallest possible position
    // breaches the cap is not tradeable.
    const esakkyResult = evaluateEsakky({
      candles1m: candles, ltp, config: strategy.esakky, optionQuote, capital, lotSize,
    });

    const decision = esakkyDecision(esakkyResult, {
      hasOpenPosition: stillOpen, capital, lotSize, maxRiskPerTradePercent: maxRiskPct,
    });

    // Keep the evaluation for the UI. The volume-profile bins are dropped —
    // they are large and nothing renders them.
    runtime.lastEval.set(strategy.id, {
      at: new Date().toISOString(),
      state: esakkyResult.state,
      score: esakkyResult.score,
      totalFactors: esakkyResult.totalFactors,
      minConfluence: esakkyResult.minConfluence,
      direction: esakkyResult.direction,
      gates: esakkyResult.gates,
      gatesOk: esakkyResult.gatesOk,
      factors: esakkyResult.factors,
      levels: esakkyResult.levels,
      riskCheck: esakkyResult.riskCheck,
      unavailableFactors: esakkyResult.unavailableFactors,
      orb: esakkyResult.orb,
      cpr: esakkyResult.cpr,
      detail: esakkyResult.detail,
    });
    if (!decision) {
      return {
        skipped: `esakky: ${esakkyResult.state} (${esakkyResult.score}/${esakkyResult.minConfluence} factors, ` +
          `${(esakkyResult.gates || []).filter((g) => g.ok).length}/5 gates)`,
        detail: esakkyResult,
      };
    }

    const size = decision.quantity;
    const tradesToday = await tradesTodayCount(strategy.id, mode);
    const check = await checkEntry({
      strategy, settings, mode, price: ltp, quantity: size, capital,
      sector: strategy.sector || inst.exchange, tradesToday,
    });
    if (!check.ok) {
      if (check.halt) await halt(check.reason);
      return { blocked: check.reason };
    }

    // The stop and target come from the setup's own structure, not from a
    // fixed percentage in the config.
    strategy.stopLoss = decision.stop;
    strategy.target = decision.target;

    const r = await executeEntry({
      strategy, inst, side: decision.side, quantity: size, price: ltp,
      mode, settings, state,
    });
    return {
      entered: {
        symbol: inst.symbol, side: decision.side, quantity: size,
        stop: decision.stop, target: decision.target, rewardRisk: decision.rewardRisk,
        esakky: { state: esakkyResult.state, score: esakkyResult.score, direction: esakkyResult.direction },
        ...r,
      },
    };
  }

  const evalCtx = ctx;
  if (!evaluateAll(strategy.entry.conditions, evalCtx, prev)) {
    return { skipped: 'conditions not met', trace: explain(strategy.entry.conditions, evalCtx, prev) };
  }

  const capital = state.capital;
  const size = positionSize({ strategy, settings, price: ltp });
  const tradesToday = await tradesTodayCount(strategy.id, mode);
  const check = await checkEntry({
    strategy, settings, mode, price: ltp, quantity: size, capital,
    sector: strategy.sector || inst.exchange, tradesToday,
  });
  if (!check.ok) {
    if (check.halt) await halt(check.reason);
    return { blocked: check.reason };
  }

  const { stopLoss, target } = exitLevels({
    side: strategy.entry.side, entryPrice: ltp, exit: strategy.exit,
  });
  strategy.stopLoss = stopLoss;
  strategy.target = target;

  const r = await executeEntry({
    strategy, inst, side: strategy.entry.side, quantity: size, price: ltp,
    mode, settings, state,
  });
  return { entered: { symbol: inst.symbol, side: strategy.entry.side, quantity: size, ...r } };
}

async function tradesTodayCount(strategyId, mode) {
  const day = new Date().toISOString().slice(0, 10);
  const trades = await listTrades({ mode, limit: 500 });
  return trades.filter((t) => t.opened_at?.slice(0, 10) === day && t.strategy_id === strategyId).length;
}

async function snapshotEquity(state, settings) {
  const mode = state.mode;
  const realised = await getTodayRealised(mode);
  const open = await getOpenPositions(mode);
  let unrealised = 0;
  for (const p of open) {
    try {
      const inst = await resolvedById(p);
      const q = inst ? await fetchQuote(inst) : null;
      const ltp = Number(q?.lastPrice ?? 0);
      if (!ltp) continue;
      const dir = p.side === 'SELL' ? -1 : 1;
      unrealised += (ltp - Number(p.avg_price)) * dir * Math.abs(Number(p.quantity));
    } catch { /* keep going */ }
  }
  const equity = state.capital + realised + unrealised;
  await recordEquity(mode, equity, realised);
  return { equity, realised, unrealised, open: open.length };
}

let idToStrategy = new Map();
async function resolvedById(position) {
  if (idToStrategy.size === 0) {
    for (const s of runtime.config?.strategies || []) idToStrategy.set(s.id, s);
  }
  const s = idToStrategy.get(position.strategy_id);
  return s ? resolveInstrument(s.instrument) : null;
}

async function tick() {
  const state = await getState();
  if (!state.running) return;
  runtime.lastTick = new Date().toISOString();
  runtime.ticks += 1;

  try {
    // Re-read the config every tick, so a strategy toggled from the UI — or
    // the JSON edited by hand — takes effect without restarting the bot.
    // Without this, both are silently ignored until the next restart.
    await reloadConfig();
    idToStrategy = new Map();

    const { settings, strategies } = runtime.config || {};
    const enabled = (strategies || []).filter((s) => s.enabled);
    for (const strategy of enabled) {
      try {
        const result = await runStrategy(strategy, state, settings, state.mode);
        if (result?.entered) log('entry', result.entered);
        else if (result?.closed) log('exit', result.closed);
      } catch (e) {
        log('error', `${strategy.id}: ${e.message}`);
      }
    }
    const snap = await snapshotEquity(state, settings);
    log('tick', snap);
  } catch (e) {
    log('error', e.message);
  }
}

/* ------------------------------------------------------------ controls --- */

export async function start() {
  if (runtime.timer) return { ok: false, reason: 'already running' };
  await reloadConfig();
  runtime.symbols.clear();
  runtime.prevCtx.clear();
  runtime.lastEval.clear();
  idToStrategy = new Map();
  resetAll();
  const state = await setState({ running: true, startedAt: new Date().toISOString(), haltedReason: null });
  runtime.timer = setInterval(tick, TICK_MS);
  unref(runtime.timer);
  log('start', { mode: state.mode });
  return { ok: true, state };
}

export async function stop() {
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = null;
  const state = await setState({ running: false, armed: false });
  log('stop', null);
  return { ok: true, state };
}

export async function halt(reason = 'manual halt') {
  const state = await getState();
  if (state.mode === 'live') {
    const open = await getOpenPositions('live');
    for (const p of open) {
      try {
        await executeExit({
          strategy: { id: p.strategy_id, strategy_id: p.strategy_id }, position: p,
          exitPrice: p.avg_price, reason: 'kill-switch', mode: 'live',
          settings: runtime.config?.settings || {}, state,
        });
      } catch (e) {
        log('error', `flatten ${p.symbol} failed: ${e.message}`);
      }
    }
  }
  await setState({ running: false, armed: false, haltedReason: reason });
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = null;
  log('halt', reason);
  return { ok: true, reason };
}

export async function setMode(mode) {
  if (!['paper', 'live'].includes(mode)) return { ok: false, reason: 'mode must be paper or live' };
  const state = await setState({ mode });
  log('mode', mode);
  return { ok: true, state };
}

export async function arm() {
  if (!liveBrokerStatus().enabled) {
    return { ok: false, reason: liveBrokerStatus().reasons.join('; ') };
  }
  const state = await getState();
  if (state.mode !== 'live') return { ok: false, reason: 'Switch to LIVE before arming.' };
  const s = await setState({ armed: true });
  log('armed', null);
  return { ok: true, state: s };
}

export async function disarm() {
  const s = await setState({ armed: false });
  log('disarmed', null);
  return { ok: true, state: s };
}

export async function status() {
  const state = await getState();
  // Read from disk so the UI reflects the file rather than a stale snapshot.
  const { settings, strategies } = await reloadConfig();
  const exposure = await sectorExposureSafe(state.mode, state.capital);
  return {
    ...state,
    live: liveBrokerStatus(),
    settings,
    strategies: strategies.map((s) => ({
      ...s,
      symbol: runtime.symbols.get(s.id)?.symbol || null,
      resolved: runtime.symbols.get(s.id)?.resolved || null,
      lastEval: runtime.lastEval.get(s.id) || null,
    })),
    exposure,
    ticks: runtime.ticks,
    lastTick: runtime.lastTick,
    equity: await latestEquity(state.mode),
  };
}

async function sectorExposureSafe(mode, capital) {
  try {
    const { sectorExposure } = await import('./risk.js');
    return await sectorExposure(mode, capital);
  } catch { return {}; }
}

async function latestEquity(mode) {
  try {
    const curve = await import('./store.js');
    const rows = await curve.getEquityCurve(mode, 1);
    return rows[0] || null;
  } catch { return null; }
}

export async function recentLog(n = 50) {
  return runtime.log.slice(0, n);
}

export { STRATEGIES_FILE, CONFIG_DIR };

function unref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
}

export const engine = { start, stop, halt, setMode, arm, disarm, status, recentLog };
