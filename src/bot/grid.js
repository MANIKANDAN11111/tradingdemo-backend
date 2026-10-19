/**
 * Grid-row mappers for the broker dashboard tables.
 *
 * The bot store returns raw snake_case rows; the dashboard grids want flat,
 * display-ready objects (IST dates, weekday names, capital, net figures).
 * Keeping the mapping in one module means every broker tab renders identical
 * columns.
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const round2 = (n) => Math.round(n * 100) / 100;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const pad = (x) => String(x).padStart(2, '0');

/** Local calendar date (YYYY-MM-DD). The reference grids show IST dates. */
function dateOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function weekdayOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : WEEKDAYS[d.getDay()];
}

function timeOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Option type from the symbol tail. Groww index symbols end in `CE`/`PE`
 * preceded by the strike digits (e.g. NIFTY26O1922950CE).
 *
 * The digit anchor matters: a bare `/(CE|PE)$/` matches the tail of RELIANCE,
 * which is an equity, not an option. Futures and equities report `—` rather
 * than guessing from the trade side.
 */
export function optionTypeOf(symbol) {
  const m = /(\d)(CE|PE)$/i.exec(String(symbol || '').trim());
  return m ? m[2].toUpperCase() : '—';
}

/**
 * One completed round trip.
 *
 * `bot_trades.pnl` already has charges deducted (engine.paperClose stores
 * `gross - charges`), so the gross figure is recovered by ADDING charges back.
 * Do not subtract here — the Net column would double-count the charges.
 */
export function tradeRow(t = {}) {
  const qty = num(t.quantity);
  const entry = num(t.entry_price);
  const exit = num(t.exit_price);
  const charges = num(t.charges);
  const netPnl = num(t.pnl);

  return {
    id: t.id,
    mode: t.mode,
    strategyId: t.strategy_id,
    symbol: t.symbol,
    side: t.side,
    type: optionTypeOf(t.symbol),
    date: dateOf(t.opened_at),
    day: weekdayOf(t.opened_at),
    entry,
    exit,
    qty,
    // Reference defines capital as "entry premium × qty".
    capital: round2(entry * qty),
    pnl: round2(netPnl + charges),
    charges,
    netPnl,
    reason: t.exit_reason || '—',
    openedAt: t.opened_at,
    closedAt: t.closed_at,
    openedTime: timeOf(t.opened_at),
    closedTime: timeOf(t.closed_at),
  };
}

/** One position row, open or already squared off. */
export function positionRow(p = {}) {
  const qty = num(p.quantity);
  const avg = num(p.avg_price);
  const closed = Boolean(p.closed_at);

  return {
    id: p.id,
    mode: p.mode,
    strategyId: p.strategy_id,
    symbol: p.symbol,
    exchange: p.exchange,
    segment: p.segment,
    side: p.side,
    type: optionTypeOf(p.symbol),
    qty,
    avgPrice: avg,
    stopLoss: p.stop_loss != null ? num(p.stop_loss) : null,
    target: p.target != null ? num(p.target) : null,
    sector: p.sector || '—',
    value: round2(avg * qty),
    pnl: p.realised_pnl != null ? num(p.realised_pnl) : null,
    exitPrice: p.exit_price != null ? num(p.exit_price) : null,
    status: closed ? 'CLOSED' : 'OPEN',
    date: dateOf(p.opened_at),
    day: weekdayOf(p.opened_at),
    openedTime: timeOf(p.opened_at),
    openedAt: p.opened_at,
    closedAt: p.closed_at,
  };
}
