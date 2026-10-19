import { deepCamel } from '../util/case.js';
import { groww } from '../growwClient.js';
import { fyers } from '../fyersClient.js';
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

// Poll interval in seconds, read from strategies.json `settings.pollSeconds`.
// Scheduled with a self-rescheduling timer rather than a fixed setInterval so
// the value takes effect without restarting the bot.
const DEFAULT_POLL_SECONDS = 300;
const MAX_LOG = 200;

const runtime = {
  timer: null,
  config: null,
  symbols: new Map(),      // strategyId -> { inst, until, failedUntil, error }
  prevCtx: new Map(),      // strategyId -> previous context (for crosses)
  lastEval: new Map(),     // strategyId -> last confluence evaluation (for the UI)
  lastTick: null,
  ticks: 0,
  sessionDate: null,       // IST date of the candles currently in memory
  log: [],
};

/**
 * How long a resolved symbol is trusted. The weekly expiry rolls over and the
 * ATM strike drifts as spot moves, so an unbounded cache serves a stale symbol.
 */
const SYMBOL_TTL_MS = 5 * 60_000;
/**
 * How long a FAILED resolution is remembered before it is retried. Caching a
 * failure forever is what deadlocks a strategy for the whole session: it can
 * never recover from one bad lookup that happened to land before market open.
 */
const SYMBOL_FAILURE_TTL_MS = 15_000;

/** Consecutive all-strategies-failed ticks before the loop backs off. */
const STALL_THRESHOLD = 10;
const STALL_COOLDOWN_MS = 60_000;
const stall = { consecutive: 0, cooldownUntil: 0 };

/* ------------------------------------------------------------------ log --- */

function sameDetail(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * IST wall-clock 'HH:MM:SS'.
 *
 * Every strategy window in strategies.json is IST, and the engine compares IST
 * minutes — so a UTC timestamp here is 5h30m off and reads as if the bot ran
 * hours ago. The raw ISO `time` is kept for sorting and as React keys.
 */
function istClock(d = new Date()) {
  return new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(11, 19);
}

function log(event, detail = null) {
  const entry = { time: new Date().toISOString(), timeIst: istClock(), event, detail };
  const prev = runtime.log[0];
  // An error repeated every 2s buries every other entry and makes the log
  // useless, so identical consecutive entries are collapsed into one counter.
  if (prev && prev.event === event && sameDetail(prev.detail, detail)) {
    prev.count = (prev.count || 1) + 1;
    prev.time = entry.time;
    return prev;
  }
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

/**
 * Resolve (and cache) the instrument a strategy trades.
 *
 * Returns null instead of throwing: a strategy whose symbol cannot be resolved
 * is SKIPPED for the tick, not fatal to the loop, and it retries after
 * SYMBOL_FAILURE_TTL_MS rather than being cached dead for the session.
 */
async function resolved(strategy) {
  const now = Date.now();
  const entry = runtime.symbols.get(strategy.id);

  if (entry?.inst && now < entry.until) return entry.inst;
  if (!entry?.inst && entry?.failedUntil && now < entry.failedUntil) return null;

  try {
    const inst = await resolveInstrument(strategy.instrument);
    runtime.symbols.set(strategy.id, {
      inst, until: now + SYMBOL_TTL_MS, failedUntil: 0, error: null,
    });
    return inst;
  } catch (e) {
    runtime.symbols.set(strategy.id, {
      inst: null, until: 0, failedUntil: now + SYMBOL_FAILURE_TTL_MS, error: e.message,
    });
    return null;
  }
}

/**
 * How long a quote is reused. Three strategies polling every 2s each used to
 * fire their own upstream request — ~90/min against Fyers' Standard-plan
 * allowance of 50 data requests/min — which tripped the 429 circuit breaker
 * and risked a same-day account block. One call per symbol per few seconds
 * collapses that to a fraction of the budget.
 */
const QUOTE_TTL_MS = 3_000;

async function fetchQuote(inst) {
  // Single-flight at the call site: strategies on the same underlying resolve
  // to the same ATM symbol, so they share one upstream request.
  const key = inst.quoteSymbol || `${inst.exchange}:${inst.segment}:${inst.symbol}`;
  return cached(`bot:quote:${key}`, QUOTE_TTL_MS, () => fetchQuoteUncached(inst));
}

async function fetchQuoteUncached(inst) {
  // Fyers-native symbol (NSE:NIFTY26O1923000CE) — only Fyers can quote it.
  // Its quote payload nests the values under `v`, and the LTP key is `lp`.
  if (inst.quoteSymbol) {
    try {
      const [q] = await fyers.quotes([inst.quoteSymbol]);
      const v = q?.v ?? {};
      const ltp = Number(v.lp ?? 0);
      if (ltp) {
        const prevClose = Number(v.prev_close_price ?? 0) || null;
        return {
          lastPrice: ltp,
          volume: Number(v.volume ?? 0),
          ohlc: {
            open: Number(v.open_price ?? 0) || null,
            high: Number(v.high_price ?? 0) || null,
            low: Number(v.low_price ?? 0) || null,
            close: prevClose,
            prevClose,
          },
          source: 'fyers',
        };
      }
    } catch { /* fall through to Groww */ }
  }

  // Groww-native symbol.
  try {
    const raw = await groww.quote({ exchange: inst.exchange, segment: inst.segment, tradingSymbol: inst.symbol });
    return { ...deepCamel(raw), source: 'groww' };
  } catch {
    const ltpKey = `${inst.exchange}_${inst.symbol}`;
    const map = await cached(`bot:ltp:${ltpKey}`, 2_000, () => groww.ltp([ltpKey], inst.segment));
    const v = map?.[ltpKey];
    const ltp = typeof v === 'number' ? v : v?.lastPrice ?? v?.ltp ?? null;
    return ltp != null ? { lastPrice: ltp, source: 'groww' } : null;
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
    await updateOrder(id, { status: 'FILLED', fillPrice: res.fillPrice, reason: `entry filled by Fyers #${res.brokerOrderId}` });
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
    await updateOrder(id, { status: 'FILLED', fillPrice: res.fillPrice, reason: `exit filled by Fyers #${res.brokerOrderId}` });
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
  const inst = await resolved(strategy);
  if (!inst) {
    const reason = runtime.symbols.get(strategy.id)?.error;
    return { skipped: `unresolved symbol${reason ? `: ${reason}` : ''}`, noData: true };
  }

  const q = await fetchQuote(inst);
  const ltp = Number(q?.lastPrice ?? inst.ltp ?? 0);
  if (!ltp) return { skipped: 'no LTP', symbol: inst.symbol, noData: true };

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

  // Data feed is down: back off rather than hammering a broker that is
  // refusing us, which on Fyers turns a limit into a same-day block.
  if (Date.now() < stall.cooldownUntil) {
    runtime.lastTick = new Date().toISOString();
    return;
  }

  runtime.lastTick = new Date().toISOString();
  runtime.ticks += 1;

  try {
    // Re-read the config every tick, so a strategy toggled from the UI — or
    // the JSON edited by hand — takes effect without restarting the bot.
    // Without this, both are silently ignored until the next restart.
    await reloadConfig();
    idToStrategy = new Map();

    // New IST trading day → drop the previous session's candles. Indicators,
    // the ORB opening-range baseline and the cross detection all read from
    // these bars, so carrying yesterday's (or a market-closed day's flat)
    // candles into a new session would produce bogus signals.
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    if (runtime.sessionDate && runtime.sessionDate !== today) {
      resetAll();
      runtime.prevCtx.clear();
      log('session-reset', { from: runtime.sessionDate, to: today });
    }
    runtime.sessionDate = today;

    const { settings, strategies } = runtime.config || {};
    const enabled = (strategies || []).filter((s) => s.enabled);
    const results = [];
    for (const strategy of enabled) {
      try {
        const result = await runStrategy(strategy, state, settings, state.mode);
        results.push(result);
        if (result?.entered) log('entry', result.entered);
        else if (result?.closed) log('exit', result.closed);
      } catch (e) {
        results.push({ error: e.message });
        log('error', `${strategy.id}: ${e.message}`);
      }
    }

    // A tick where nothing could be priced means the feed is down. Back off
    // after a few of those rather than retrying into a refusal.
    const gotData = results.some((r) => r && !r.noData && !r.error);
    stall.consecutive = gotData ? 0 : stall.consecutive + 1;
    if (stall.consecutive >= STALL_THRESHOLD) {
      stall.consecutive = 0;
      stall.cooldownUntil = Date.now() + STALL_COOLDOWN_MS;
      log('stall', {
        reason: 'no strategy could be priced',
        cooldownSeconds: STALL_COOLDOWN_MS / 1000,
        blockers: (await brokerHealth()).blockers,
      });
    }

    const snap = await snapshotEquity(state, settings);
    log('tick', snap);
  } catch (e) {
    log('error', e.message);
  }
}

/* ------------------------------------------------------------ controls --- */

/**
 * Self-scheduling tick loop.
 *
 * Reads `settings.pollSeconds` on every cycle instead of capturing a constant,
 * so the interval can be changed in strategies.json without a restart. A chain
 * of setTimeouts rather than setInterval, so a slow upstream call can never
 * overlap the next tick.
 */
function scheduleNextTick(initialDelayMs = null) {
  const secs = Number(runtime.config?.settings?.pollSeconds);
  const ms = initialDelayMs != null
    ? initialDelayMs
    : (Number.isFinite(secs) && secs > 0 ? secs : DEFAULT_POLL_SECONDS) * 1000;
  runtime.timer = setTimeout(async () => {
    try {
      await tick();
    } catch (e) {
      log('error', e.message);
    } finally {
      // stop() nulls runtime.timer; that null check is what ends the loop.
      if (runtime.timer) scheduleNextTick();
    }
  }, ms);
  unref(runtime.timer);
}

export async function start() {
  if (runtime.timer) return { ok: false, reason: 'already running' };
  await reloadConfig();
  runtime.symbols.clear();
  runtime.prevCtx.clear();
  runtime.lastEval.clear();
  idToStrategy = new Map();
  resetAll();
  stall.consecutive = 0;
  stall.cooldownUntil = 0;

  // Backfill historical 1m candles for each enabled strategy so signal
  // evaluation has enough data on the first tick. Without this, a 5-minute
  // poll interval means strategies wait hours before accumulating enough
  // candles to generate any signal at all.
  await backfillCandles();

  const state = await setState({ running: true, startedAt: new Date().toISOString(), haltedReason: null });
  scheduleNextTick(0);   // first tick immediately, then every pollSeconds
  // Report data availability up front: a bot that is "running" with no feed is
  // indistinguishable from a working one unless we say so.
  const brokers = await brokerHealth();
  log('start', { mode: state.mode, hasDataSource: brokers.hasDataSource, blockers: brokers.blockers });
  return { ok: true, state };
}

/**
 * Fetch recent 1m OHLC candles from Groww for each strategy's resolved symbol
 * and feed them into the candle store. This gives indicators enough history
 * to produce meaningful values on the very first tick.
 */
async function backfillCandles() {
  const { strategies } = runtime.config || {};
  const enabled = (strategies || []).filter((s) => s.enabled);

  for (const strategy of enabled) {
    try {
      const inst = await resolveInstrument(strategy.instrument);
      const candleMs = Number(strategy.entry.candleMinutes ?? 1) * 60_000;
      const key = `${strategy.id}:${inst.symbol}`;

      // Groww OHLC returns recent intraday candles. We use the underlying
      // (spot) symbol — Groww's live-data/ohlc works with NSE_NIFTY style keys.
      const ltpKey = `${inst.exchange}_${inst.symbol}`;
      const raw = await groww.ohlc([ltpKey], inst.segment).catch(() => null);
      const rows = raw?.[ltpKey] ?? raw ?? [];
      if (!Array.isArray(rows) || rows.length === 0) continue;

      // Feed oldest→newest so the candle store ends with the most recent bar.
      for (const row of rows.slice(-50)) {
        const time = row.time ? new Date(row.time).getTime() : Date.now();
        feed(key, { price: row.close ?? row.ltp ?? 0, volume: row.volume ?? 0, time }, candleMs);
      }
      log('backfill', { symbol: inst.symbol, strategy: strategy.id, candles: Math.min(rows.length, 50) });
    } catch (e) {
      log('backfill-error', { strategy: strategy.id, error: e.message });
    }
  }
}

export async function stop() {
  if (runtime.timer) clearTimeout(runtime.timer);
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
  if (runtime.timer) clearTimeout(runtime.timer);
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
  const brokers = await brokerHealth();
  return {
    ...state,
    live: liveBrokerStatus(),
    brokers,
    settings,
    strategies: strategies.map((s) => ({
      ...s,
      symbol: runtime.symbols.get(s.id)?.inst?.symbol || null,
      resolved: runtime.symbols.get(s.id)?.inst?.resolved || null,
      resolveError: runtime.symbols.get(s.id)?.error || null,
      lastEval: runtime.lastEval.get(s.id) || null,
    })),
    exposure,
    ticks: runtime.ticks,
    lastTick: runtime.lastTick,
    stalled: Date.now() < stall.cooldownUntil,
    stallCooldownUntil: stall.cooldownUntil ? new Date(stall.cooldownUntil).toISOString() : null,
    equity: await latestEquity(state.mode),
  };
}

/**
 * Why the bot has no data, in one place.
 *
 * The engine and the UI both read this so "the bot is doing nothing" becomes a
 * specific, actionable line of text instead of an empty log and a flat equity
 * curve.
 */
async function brokerHealth() {
  const [{ growwHealth, growwHoldbackStatus }, { fyersHealth }] = await Promise.all([
    import('../growwClient.js'),
    import('../fyersClient.js'),
  ]);
  const groww = growwHealth();
  const fyers = fyersHealth();
  return {
    groww,
    fyers,
    growwHoldback: growwHoldbackStatus(),
    // Nothing can trade without at least one live chain source.
    hasDataSource: Boolean(groww.ok || fyers.ok),
    blockers: [...groww.problems, ...fyers.problems],
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

export const engine = { start, stop, halt, setMode, arm, disarm, status, recentLog, fetchQuote };
