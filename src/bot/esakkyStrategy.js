/**
 * Esakky BALA A+ Strategy evaluator.
 *
 * Multi-timeframe confluence system, implemented against the strategy spec:
 *
 *   15m context       directional bias, liquidity sweep, ORB, key levels
 *   5m confirmation   BOS/CHoCH on a *completed* candle, displacement, FVG/OB
 *   1m execution      completed trigger candle
 *
 * Two independent things must both hold before an entry is allowed:
 *
 *   1. The five mandatory rules in `mandatory_rules`.
 *   2. A confluence score of at least `minimum_points` out of `total_points`.
 *
 * Data honesty (`missing_data_counts_as_positive: false`):
 *   A factor whose feed is not available scores nothing and is reported as
 *   `available: false` rather than being faked from a proxy. Two of the
 *   eleven factors depend on feeds this deployment does not have:
 *     - FRVP: computed from a candle-derived volume profile, labelled as such.
 *     - Option-premium reaction: needs the option's own quote; only scores
 *       when the engine passes one in.
 *   So the effective ceiling is 11 when an option quote is present and 10 when
 *   it is not — and the 7-point minimum is enforced against the full 11 either
 *   way, which is the conservative reading of the spec.
 *
 * Risk (`risk`):
 *   The stop is structural — the invalidation level of the setup plus a
 *   volatility buffer — not a fixed percentage. The target is the configured
 *   R-multiple, extended to the opposing liquidity level when that is further
 *   away. A setup whose reward:risk is below `minimum_reward_risk` is not
 *   traded, no matter how many factors it scores.
 *
 * Signal states (spec `signal_states`):
 *   A_PLUS_PAPER_LONG_CALL_BIAS   bullish A+ setup → buy CE
 *   A_PLUS_PAPER_SHORT_PUT_BIAS   bearish A+ setup → buy PE
 *   WATCH                         setup forming, gates or score not yet met
 *   NO_TRADE                      no setup, or a risk filter failed
 *   DATA_UNAVAILABLE              not enough candle data to evaluate
 */
import {
  atr, vwap, rvol, aggregate, openingRange,
  structuralSweep, recentStructureBreak, latestFVG, fvgRetest, orderBlockFor, isBreaker,
  swingPoints, recentDisplacement, volumeProfile, profileContext, cpr, cprFrom, priorSession,
} from './indicators.js';

const MIN_CONFLUENCE = 7;
const TOTAL_FACTORS = 11;

export const ESAKKY_STATE = {
  LONG_CALL: 'A_PLUS_PAPER_LONG_CALL_BIAS',
  SHORT_PUT: 'A_PLUS_PAPER_SHORT_PUT_BIAS',
  WATCH: 'WATCH',
  NO_TRADE: 'NO_TRADE',
  DATA_UNAVAILABLE: 'DATA_UNAVAILABLE',
};

const STATE = ESAKKY_STATE;

/** The last fully-closed candle. The final element is still forming. */
function closed(candles) {
  return Array.isArray(candles) && candles.length > 1 ? candles.slice(0, -1) : [];
}

/** A candle that closed with directional intent (used for the 1m trigger). */
function triggerCandle(candles, direction) {
  const done = closed(candles);
  const c = done[done.length - 1];
  if (!c) return null;
  const range = c.high - c.low;
  if (range <= 0) return null;
  const body = Math.abs(c.close - c.open);
  const bull = c.close > c.open;
  if (direction === 'bullish' && bull && body / range >= 0.5) return c;
  if (direction === 'bearish' && !bull && body / range >= 0.5) return c;
  return null;
}

/**
 * Evaluate the strategy against the 1m candle history.
 *
 * @param {object}   args
 * @param {Array}    args.candles1m     in-progress 1m candles (last is forming)
 * @param {number}   args.ltp           last traded price of the underlying
 * @param {object}   [args.config]      the strategy's `esakky` block
 * @param {object}   [args.optionQuote] { ltp, prevClose } of the resolved option, if any
 * @param {Array}    [args.dailyCandles] daily candles, for a true prior-session CPR
 */
export function evaluateEsakky({
  candles1m, ltp, config = {}, optionQuote = null, dailyCandles = null,
  capital = 0, lotSize = 1,
}) {
  const risk = config.risk || {};
  const cfg = {
    minConfluence: Number(config.confluence_score?.minimum_points ?? MIN_CONFLUENCE),
    totalFactors: Number(config.confluence_score?.total_points ?? TOTAL_FACTORS),
    minRewardRisk: Number(risk.minimum_reward_risk ?? 1.5),
    maxRiskPct: Number(risk.max_risk_per_trade_percent ?? 1),
    atrBufferMult: Number(config.atr_buffer_mult ?? 0.25),
    rvolMin: Number(config.rvol_min ?? 1.2),
    // How far back to look for the confirmation break and displacement. A BALA
    // setup runs sweep → BOS → retest → trigger, so the break sits several
    // candles behind the entry. 8 × 5m = the last 40 minutes.
    confirmLookback: Number(config.confirm_lookback ?? 8),
  };

  const price = Number(ltp);
  if (!price) {
    return unavailable('No last-traded price.');
  }

  // ~30 1m candles is the minimum for 15m structure to mean anything.
  if (!Array.isArray(candles1m) || candles1m.length < 30) {
    return unavailable(`Insufficient 1m candle data (have ${candles1m?.length ?? 0}, need 30+).`);
  }

  const candles5m = aggregate(candles1m, 5 * 60_000);
  const candles15m = aggregate(candles1m, 15 * 60_000);
  if (candles5m.length < 6 || candles15m.length < 3) {
    return unavailable('Insufficient higher-timeframe data.');
  }

  // Structure is read from closed candles only.
  const c5 = closed(candles5m);
  const c15 = closed(candles15m);
  const c1 = closed(candles1m);
  if (c5.length < 5 || c15.length < 2 || c1.length < 5) {
    return unavailable('Not enough closed candles for structure.');
  }

  const atr5 = atr(c5, 14);
  const atr1 = atr(c1, 14);
  const orb = openingRange(candles15m, 15);

  /* ------------------------------------------------------------ factors --- */

  const factors = [];
  const add = (name, met, available, detail) => {
    factors.push({ name, met: Boolean(met) && available, available, detail: detail ?? null });
  };

  // 1. Liquidity sweep — swing-structure sweep on the 15m context.
  const sweep15 = structuralSweep(c15, { left: 2, right: 2 });
  add('Liquidity sweep', Boolean(sweep15), true,
    sweep15 ? `${sweep15.side === 'buy' ? 'sell-side' : 'buy-side'} sweep of ${sweep15.level.toFixed(1)}` : 'no sweep');

  // 2. BOS/CHoCH alignment — on a completed 5m candle, within the lookback.
  const brk5 = recentStructureBreak(c5, { left: 2, right: 2, lookback: cfg.confirmLookback });
  add('BOS/CHoCH alignment', Boolean(brk5), true,
    brk5 ? `${brk5.type} @ ${brk5.level.toFixed(1)}` : 'no break');

  // 3. Displacement on the 5m confirmation timeframe.
  const disp5 = recentDisplacement(c5, { period: 20, minRangeMult: 1.5, lookback: cfg.confirmLookback });
  add('Displacement', Boolean(disp5), true,
    disp5 ? `${disp5.direction} ×${disp5.ratio.toFixed(1)}` : 'no displacement');

  // 4. FVG retest on the 5m.
  const gap5 = latestFVG(c5);
  const retested = gap5 ? fvgRetest(c5, gap5) : false;
  add('FVG retest', retested, true,
    gap5 ? `${gap5.type} FVG ${gap5.bottom.toFixed(1)}–${gap5.top.toFixed(1)}${retested ? ' (retested)' : ' (not retested)'}` : 'no FVG');

  // 5. Order block or breaker, derived from the structure break.
  const ob5 = orderBlockFor(c5, brk5);
  const breaker5 = ob5 && isBreaker(c5, ob5);
  add('Order block or breaker', Boolean(ob5), true,
    ob5 ? `${ob5.type} OB${breaker5 ? ' (breaker)' : ''}` : 'no OB');

  // 6. Volume / RVOL confirmation on the 1m.
  const rv = rvol(candles1m, 20);
  add('Volume/RVOL confirmation', rv != null && rv >= cfg.rvolMin, rv != null,
    rv != null ? `RVOL ${rv.toFixed(2)}×` : 'no volume data');

  // 7. VWAP alignment — the real session VWAP, not a proxy.
  const vw = vwap(c1);
  const vwapSide = vw == null ? null : price > vw ? 'bullish' : price < vw ? 'bearish' : 'flat';
  add('VWAP alignment', vwapSide === 'bullish' || vwapSide === 'bearish', vw != null,
    vw != null ? `price ${vwapSide} of VWAP ${vw.toFixed(1)}` : 'no VWAP');

  // 8. 15m opening-range alignment.
  const orbSide = !orb ? null : price > orb.high ? 'bullish' : price < orb.low ? 'bearish' : 'inside';
  add('15m ORB alignment', orbSide === 'bullish' || orbSide === 'bearish', Boolean(orb),
    orb ? `price ${orbSide} ORB ${orb.low.toFixed(1)}–${orb.high.toFixed(1)}` : 'ORB not formed');

  // 9. FRVP context — candle-derived volume profile. Labelled as derived.
  const profile = volumeProfile(c15, 24, 0.7);
  const pCtx = profile ? profileContext(price, profile) : null;
  add('FRVP context', pCtx === 'above-value' || pCtx === 'below-value', Boolean(profile),
    profile ? `profile ${pCtx} (POC ${profile.poc.toFixed(1)}) — derived from candles` : 'no volume data');

  // 10. CPR / key-level context — prior session when we have it.
  const prior = priorSession(dailyCandles);
  const cprLevels = prior ? cprFrom(prior.high, prior.low, prior.close) : cpr(c15);
  const cprSide = !cprLevels ? null : price > cprLevels.tc ? 'bullish' : price < cprLevels.bc ? 'bearish' : 'inside';
  add('CPR/key-level context', cprSide === 'bullish' || cprSide === 'bearish', Boolean(cprLevels),
    cprLevels ? `price ${cprSide} CPR (cp ${cprLevels.cp.toFixed(1)}${prior ? '' : ', rolling'})` : 'no CPR');

  // 11. Option-premium reaction zone — only scores with a real option quote.
  const optLtp = Number(optionQuote?.ltp);
  const optPrev = Number(optionQuote?.prevClose);
  const optAvailable = Number.isFinite(optLtp) && optLtp > 0;
  const premiumMove = optAvailable && Number.isFinite(optPrev) && optPrev > 0
    ? (optLtp - optPrev) / optPrev
    : null;
  add('Option-premium reaction zone', premiumMove != null && Math.abs(premiumMove) >= 0.03, optAvailable,
    premiumMove != null
      ? `premium ${(premiumMove * 100).toFixed(1)}% vs prev close`
      : optAvailable ? 'premium quote has no prev close' : 'no option quote in this feed');

  const metFactors = factors.filter((f) => f.met);
  const score = metFactors.length;
  const unavailableCount = factors.filter((f) => !f.available).length;

  /* ------------------------------------------------------- directional vote --- */

  let bullVotes = 0;
  let bearVotes = 0;
  const vote = (side) => { if (side === 'bullish') bullVotes += 1; else if (side === 'bearish') bearVotes += 1; };

  if (sweep15) vote(sweep15.side === 'buy' ? 'bullish' : 'bearish');
  if (brk5) vote(brk5.type.includes('up') ? 'bullish' : 'bearish');
  if (disp5) vote(disp5.direction);
  if (gap5 && retested) vote(gap5.type);
  if (ob5) vote(ob5.type);
  if (vwapSide) vote(vwapSide);
  if (orbSide) vote(orbSide);
  if (pCtx === 'above-value') vote('bullish');
  if (pCtx === 'below-value') vote('bearish');
  if (cprSide) vote(cprSide);

  const direction = bullVotes > bearVotes ? 'bullish' : bearVotes > bullVotes ? 'bearish' : null;

  /* ------------------------------------------------------ mandatory gates --- */

  const gates = [];
  const gate = (rule, ok, detail) => gates.push({ rule, ok, detail: detail ?? null });

  // 1. Clear directional context, or a liquidity-sweep reversal.
  gate('Clear directional context or liquidity-sweep reversal',
    Boolean(direction) || Boolean(sweep15),
    direction ? `${direction} (${bullVotes}v${bearVotes})` : sweep15 ? 'sweep reversal' : 'no direction');

  // 2. Valid 15m structure / ORB / key-level context.
  const hasContext = Boolean(brk5) || (orbSide && orbSide !== 'inside') || (cprSide && cprSide !== 'inside');
  gate('Valid 15m structure/ORB/key-level context', hasContext,
    hasContext ? 'context present' : 'no 15m context');

  // 3. Completed 5m BOS/CHoCH with displacement.
  const confirmOk = Boolean(brk5) && Boolean(disp5)
    && (!direction || (direction === 'bullish' ? brk5.type.includes('up') : brk5.type.includes('down')));
  gate('Completed 5m BOS/CHoCH with displacement', confirmOk,
    confirmOk ? `${brk5.type} + displacement` : 'confirmation incomplete');

  // 4. Completed 1m trigger after confirmation.
  const trigger = direction ? triggerCandle(candles1m, direction) : null;
  gate('Completed 1m trigger after confirmation', Boolean(trigger),
    trigger ? `1m ${direction} candle @ ${trigger.close.toFixed(1)}` : 'no 1m trigger');

  /* ---------------------------------------------- structural stop / target --- */

  const levels = direction ? structuralLevels({ direction, price, c15, c5, ob5, sweep15, atr5, cfg }) : null;
  const rr = levels ? levels.rewardRisk : null;
  // An epsilon, because a setup built to sit exactly on the threshold (or a
  // stop computed from a fractional ATR buffer) must not be rejected by
  // floating-point noise on the last bit.
  const riskOk = Boolean(levels) && rr != null && rr >= cfg.minRewardRisk - 1e-9;

  // The smallest tradable position must fit inside the per-trade risk budget.
  // One NIFTY lot against a wide structural stop can risk far more than 1% of
  // a small account. When it does, the setup is untradeable — it must not be
  // quietly sized past the limit.
  const riskCheck = buildRiskCheck({ levels, capital, lotSize, maxRiskPct: cfg.maxRiskPct });
  const fitsBudget = riskCheck ? riskCheck.fits : true;

  // 5. Structural stop, realistic target, acceptable R:R, risk filters pass.
  gate('Structural stop, realistic target, acceptable R:R', riskOk && fitsBudget,
    levels
      ? `stop ${levels.stop.toFixed(1)} · target ${levels.target.toFixed(1)} · R:R ${rr.toFixed(2)}` +
        (riskCheck
          ? ` · 1 lot risks ${riskCheck.minLotRisk.toFixed(0)} vs budget ${riskCheck.riskBudget.toFixed(0)}` +
            (riskCheck.fits ? '' : ' — OVER BUDGET')
          : '')
      : 'no structural levels');

  const gatesOk = gates.every((g) => g.ok);
  const passed = gatesOk && score >= cfg.minConfluence;

  /* ---------------------------------------------------------------- state --- */

  let state;
  if (passed && direction === 'bullish') state = STATE.LONG_CALL;
  else if (passed && direction === 'bearish') state = STATE.SHORT_PUT;
  else if (score >= 4 || gates.filter((g) => g.ok).length >= 3) state = STATE.WATCH;
  else state = STATE.NO_TRADE;

  return {
    state,
    score,
    minConfluence: cfg.minConfluence,
    totalFactors: cfg.totalFactors,
    factors,
    gates,
    gatesOk,
    passed,
    direction,
    votes: { bull: bullVotes, bear: bearVotes },
    levels,
    rewardRisk: rr,
    riskCheck,
    atr: { m1: atr1, m5: atr5 },
    orb: orb ? { high: orb.high, low: orb.low } : null,
    cpr: cprLevels,
    profile: profile ? { poc: profile.poc, vah: profile.vah, val: profile.val, derived: true } : null,
    unavailableFactors: factors.filter((f) => !f.available).map((f) => f.name),
    detail: `${score}/${cfg.totalFactors} factors · ${gates.filter((g) => g.ok).length}/5 gates · ${direction || 'no direction'}` +
      (unavailableCount ? ` · ${unavailableCount} feed(s) unavailable` : ''),
  };
}

function unavailable(detail) {
  return {
    state: STATE.DATA_UNAVAILABLE,
    score: 0,
    minConfluence: MIN_CONFLUENCE,
    totalFactors: TOTAL_FACTORS,
    factors: [],
    gates: [],
    gatesOk: false,
    passed: false,
    direction: null,
    votes: { bull: 0, bear: 0 },
    levels: null,
    rewardRisk: null,
    riskCheck: null,
    detail,
  };
}

/**
 * Can the smallest tradable position be taken without breaching the per-trade
 * risk cap? Returns null when capital is unknown, in which case no judgement
 * is made and the caller falls back to the configured lot.
 */
function buildRiskCheck({ levels, capital, lotSize, maxRiskPct }) {
  if (!levels || !(levels.riskDistance > 0)) return null;
  const cap = Number(capital) || 0;
  if (cap <= 0) return null;
  const riskBudget = cap * (Number(maxRiskPct) / 100);
  const minLotRisk = levels.riskDistance * Math.max(1, Number(lotSize) || 1);
  return { riskBudget, minLotRisk, fits: minLotRisk <= riskBudget + 1e-9 };
}

/**
 * Structural invalidation level plus a volatility buffer, and a target at the
 * configured R-multiple extended to the opposing liquidity level when that is
 * further away. Returns null when no sane level exists.
 */
function structuralLevels({ direction, price, c15, c5, ob5, sweep15, atr5, cfg }) {
  const buffer = (Number(atr5) || 0) * cfg.atrBufferMult;
  const long = direction === 'bullish';

  // Candidate invalidation levels behind the trade.
  const candidates = [];
  const { lows, highs } = swingPoints(c5, 2, 2);
  if (long) {
    if (lows.length) candidates.push(c5[lows[lows.length - 1]].low);
    if (ob5 && ob5.type === 'bullish') candidates.push(ob5.low);
    if (sweep15 && sweep15.side === 'buy') candidates.push(sweep15.level);
  } else {
    if (highs.length) candidates.push(c5[highs[highs.length - 1]].high);
    if (ob5 && ob5.type === 'bearish') candidates.push(ob5.high);
    if (sweep15 && sweep15.side === 'sell') candidates.push(sweep15.level);
  }
  if (!candidates.length) return null;

  // The invalidation sits at the extreme behind the trade, plus the buffer.
  const structural = long ? Math.min(...candidates) : Math.max(...candidates);
  const stop = long ? structural - buffer : structural + buffer;
  const riskDistance = Math.abs(price - stop);
  if (!(riskDistance > 0)) return null;

  // Target: R-multiple, extended to the opposing liquidity if that is further.
  const rTarget = long ? price + cfg.minRewardRisk * riskDistance : price - cfg.minRewardRisk * riskDistance;
  const opposing = long
    ? (highs.length ? c5[highs[highs.length - 1]].high : null)
    : (lows.length ? c5[lows[lows.length - 1]].low : null);

  let target = rTarget;
  if (opposing != null) {
    const beyond = long ? opposing > rTarget : opposing < rTarget;
    if (beyond) target = opposing;
  }

  const reward = Math.abs(target - price);
  return {
    stop,
    target,
    structural,
    buffer,
    riskDistance,
    reward,
    rewardRisk: riskDistance > 0 ? reward / riskDistance : null,
  };
}

/**
 * Decide whether to enter, and with what size.
 *
 * Sizing is risk-based: the spec caps risk at
 * `max_risk_per_trade_percent` of capital, so quantity is derived from the
 * structural stop distance rather than from a capital-per-trade budget.
 * The result is floored to whole lots.
 */
export function esakkyDecision(evalResult, { hasOpenPosition, capital = 0, lotSize = 1, maxRiskPerTradePercent = 1 } = {}) {
  if (!evalResult || !evalResult.passed || hasOpenPosition) return null;
  if (evalResult.state !== ESAKKY_STATE.LONG_CALL && evalResult.state !== ESAKKY_STATE.SHORT_PUT) return null;

  const { levels } = evalResult;
  if (!levels || !(levels.riskDistance > 0)) return null;

  const lot = Math.max(1, Number(lotSize) || 1);
  const cap = Number(capital) || 0;
  const riskBudget = cap * (Number(maxRiskPerTradePercent) / 100);
  const perLotRisk = levels.riskDistance * lot;

  // With capital known the risk cap is binding: if a single lot already risks
  // more than the budget, there is no valid size, so the trade is refused
  // rather than upsized past the limit.
  let lots;
  if (cap > 0) {
    lots = Math.floor((riskBudget + 1e-9) / perLotRisk);
    if (lots < 1) return null;
  } else {
    lots = 1; // capital unknown — fall back to the strategy's own lot
  }

  return {
    shouldEnter: true,
    side: 'BUY', // both biases are expressed by buying an option (CE or PE)
    bias: evalResult.direction,
    quantity: lots * lot,
    stop: levels.stop,
    target: levels.target,
    rewardRisk: levels.rewardRisk,
    riskRupees: lots * perLotRisk,
    reason: `Esakky ${evalResult.direction === 'bullish' ? 'LONG CALL' : 'SHORT PUT'} ` +
      `(${evalResult.score}/${evalResult.totalFactors} factors, R:R ${levels.rewardRisk?.toFixed(2)})`,
  };
}

export { MIN_CONFLUENCE, TOTAL_FACTORS };
