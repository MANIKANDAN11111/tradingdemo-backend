import { Router } from 'express';
import { groww } from '../growwClient.js';
import { cached, invalidate } from '../cache.js';
import { deepCamel } from '../util/case.js';

const router = Router();
// Matches the 3s UI refresh; see routes/dashboard.js for the upstream maths.
const TTL = 3_000;

router.get('/holdings', async (req, res, next) => {
  try {
    const holdings = deepCamel(await cached('holdings', TTL, () => groww.holdings()));
    res.json({ ok: true, count: holdings.length, holdings });
  } catch (err) {
    next(err);
  }
});

router.get('/positions', async (req, res, next) => {
  try {
    const segment = String(req.query.segment || 'CASH').toUpperCase();
    const positions = deepCamel(await cached(`positions:${segment}`, TTL, () => groww.positions(segment)));
    res.json({ ok: true, segment, count: positions.length, positions });
  } catch (err) {
    next(err);
  }
});

router.get('/margins', async (req, res, next) => {
  try {
    const margins = deepCamel(await cached('margins', TTL, () => groww.margins()));
    res.json({ ok: true, margins });
  } catch (err) {
    next(err);
  }
});

/** One call with everything the dashboard needs, each part failing independently. */
router.get('/summary', async (req, res, next) => {
  try {
    const [margins, holdings, cash, fno] = await Promise.allSettled([
      cached('margins', TTL, () => groww.margins()),
      cached('holdings', TTL, () => groww.holdings()),
      cached('positions:CASH', TTL, () => groww.positions('CASH')),
      cached('positions:FNO', TTL, () => groww.positions('FNO')),
    ]);

    const val = (r, fallback) => (r.status === 'fulfilled' ? r.value : fallback);
    res.json({
      ok: true,
      margins: deepCamel(val(margins, null)),
      holdings: deepCamel(val(holdings, [])),
      positions: {
        cash: deepCamel(val(cash, [])),
        fno: deepCamel(val(fno, [])),
      },
      errors: [margins, holdings, cash, fno]
        .filter((r) => r.status === 'rejected')
        .map((r) => r.reason?.message || 'unknown error'),
    });
  } catch (err) {
    next(err);
  }
});

/** Drop cached portfolio data so the next read is fresh. */
router.post('/refresh', (req, res) => {
  invalidate('holdings');
  invalidate('positions');
  invalidate('margins');
  res.json({ ok: true, refreshed: true });
});

export default router;
