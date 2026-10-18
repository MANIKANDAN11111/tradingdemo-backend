import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_DIR = path.resolve(__dirname, '..', '..', 'config');
export const STRATEGIES_FILE = path.join(CONFIG_DIR, 'strategies.json');
export const SECTORS_FILE = path.join(CONFIG_DIR, 'sectors.json');

export const DEFAULT_SETTINGS = {
  capital: 100000,
  maxLossPerDay: 5000,          // halt the bot for the day at this loss
  maxLossPerTrade: 2000,        // hard per-trade cap, independent of stop %
  maxSectorExposurePct: 25,     // industry risk factor: max % of capital per sector
  defaultCapitalPerTrade: 50000,
  slippagePct: 0.05,            // paper fills
  pollSeconds: 5,
};

const OPERATORS = ['>', '<', '>=', '<=', 'crossesAbove', 'crossesBelow', 'equals'];

export class StrategyError extends Error {}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new StrategyError(`Could not parse ${path.basename(file)}: ${e.message}`);
  }
}

/** Load and validate the strategy config. Throws StrategyError on bad input. */
export function loadConfig() {
  const raw = readJson(STRATEGIES_FILE, { strategies: [] });
  const sectors = readJson(SECTORS_FILE, {});
  const settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
  const strategies = (raw.strategies || []).map((s) => normaliseStrategy(s, settings));
  return { settings, sectors, strategies };
}

export function normaliseStrategy(s, settings = DEFAULT_SETTINGS) {
  const problems = [];
  if (!s.id) problems.push('missing "id"');
  if (!s.name) problems.push('missing "name"');
  if (!s.instrument?.underlying) problems.push('missing "instrument.underlying"');
  if (!s.entry) problems.push('missing "entry"');
  // Esakky strategies use confluence scoring instead of indicator conditions
  const isEsakky = s.type === 'esakky';
  if (!isEsakky && (!Array.isArray(s.entry?.conditions) || s.entry.conditions.length === 0)) {
    problems.push('"entry.conditions" must be a non-empty array');
  }
  if (Array.isArray(s.entry?.conditions)) {
    for (const [i, c] of s.entry.conditions.entries()) {
      if (!c.indicator) problems.push(`entry.conditions[${i}] missing "indicator"`);
      if (!OPERATORS.includes(c.op)) {
        problems.push(`entry.conditions[${i}].op must be one of ${OPERATORS.join(', ')}`);
      }
      if (c.value === undefined) problems.push(`entry.conditions[${i}] missing "value"`);
    }
  }
  if (problems.length) {
    throw new StrategyError(`Strategy "${s.id || '(unnamed)'}" is invalid: ${problems.join('; ')}`);
  }

  const instrument = {
    underlying: s.instrument.underlying,
    exchange: s.instrument.exchange || 'NSE',
    segment: s.instrument.segment || 'FNO',
    optionType: s.instrument.optionType || null,   // CE | PE | null (futures/equity)
    strikeOffset: Number(s.instrument.strikeOffset ?? 0),
    expiry: s.instrument.expiry || 'weekly',
  };

  return {
    id: s.id,
    name: s.name,
    enabled: Boolean(s.enabled),
    type: s.type || null,
    esakky: s.esakky || null,
    instrument,
    entry: {
      window: s.entry.window || null,               // { from: '09:15', to: '14:30' }
      conditions: s.entry.conditions,
      side: (s.entry.side || 'BUY').toUpperCase(),
      quantity: Number(s.entry.quantity ?? 1),
      candleMinutes: Number(s.entry.candleMinutes ?? 1),
    },
    exit: {
      stopLoss: s.exit?.stopLoss || null,           // { type: 'percent'|'points', value: n }
      target: s.exit?.target || null,
      timeExit: s.exit?.timeExit || '15:15',
      conditions: s.exit?.conditions || [],
    },
    risk: {
      maxTradesPerDay: Number(s.risk?.maxTradesPerDay ?? 3),
      capitalPerTrade: Number(s.risk?.capitalPerTrade ?? settings.defaultCapitalPerTrade),
    },
    sector: s.sector || s.instrument.underlying,
  };
}

/** Persist the config back to disk (used by the UI editor). */
export function saveConfig({ settings, strategies }) {
  const current = readJson(STRATEGIES_FILE, {});
  const next = {
    ...current,
    settings: { ...DEFAULT_SETTINGS, ...(current.settings || {}), ...(settings || {}) },
    strategies: strategies ?? current.strategies ?? [],
  };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(STRATEGIES_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return loadConfig();
}

export function loadSectors() {
  return readJson(SECTORS_FILE, {});
}
