import { Router } from 'express';
import { groww, tokenInfo } from '../growwClient.js';
import { fyers, fyersTokenInfo } from '../fyersClient.js';
import { cached } from '../cache.js';
import { deepCamel } from '../util/case.js';
import { getIndices } from './market.js';

const router = Router();
// Non-Trading (margins / holdings / positions / orders) is capped at
// 500 req/min upstream. At a 3s UI refresh this route issues ~100 such calls
// per minute.
const TTL = 3_000;

/**
 * Single aggregate endpoint the dashboard polls.
 * Every section fails independently so one dead endpoint never blanks the page.
 */
router.get('/', async (req, res, next) => {
  try {
    const [margins, holdings, cash, fno, orders, indices, fyersData] = await Promise.allSettled([
      cached('margins', TTL, () => groww.margins()),
      cached('holdings', TTL, () => groww.holdings()),
      cached('positions:CASH', TTL, () => groww.positions('CASH')),
      cached('positions:FNO', TTL, () => groww.positions('FNO')),
      cached('orders:CASH:0:50', TTL, () => groww.orders({ segment: 'CASH', page: 0, pageSize: 50 })),
      getIndices(),
      // Fyers: fetch positions, funds, orders (falls back silently if no token)
      (async () => {
        try {
          const [pos, fund, ord] = await Promise.all([
            fyers.positions(),
            fyers.funds(),
            fyers.orders(),
          ]);
          return { positions: pos, funds: fund, orders: ord };
        } catch {
          return null; // Fyers not authenticated yet
        }
      })(),
    ]);

    const val = (r, fallback) => (r.status === 'fulfilled' ? r.value : fallback);
    const errors = [margins, holdings, cash, fno, orders, indices]
      .filter((r) => r.status === 'rejected')
      .map((r) => r.reason?.message || 'unknown error');

    const fnoPositions = deepCamel(val(fno, []));
    const cashPositions = deepCamel(val(cash, []));
    const marginsData = deepCamel(val(margins, null));

    const openFno = fnoPositions.filter((p) => Number(p.quantity ?? 0) !== 0);
    const realisedPnl = fnoPositions.reduce((sum, p) => sum + Number(p.realisedPnl ?? 0), 0);
    const unrealisedPnl = openFno.reduce((sum, p) => {
      // netPrice is the average entry price for the carried position.
      return sum + Number(p.realisedPnl ?? 0);
    }, 0);

    const fyersResult = val(fyersData, null);
    const fyersAuth = fyersTokenInfo();

    res.json({
      ok: true,
      partial: errors.length > 0,
      fetchedAt: new Date().toISOString(),
      auth: tokenInfo(),
      fyersAuth,
      fyers: fyersResult,
      indices: val(indices, []),
      margins: marginsData,
      funds: marginsData
        ? {
            clearCash: marginsData.clearCash ?? null,
            netMarginUsed: marginsData.netMarginUsed ?? null,
            collateralAvailable: marginsData.collateralAvailable ?? null,
            collateralUsed: marginsData.collateralUsed ?? null,
            brokerageAndCharges: marginsData.brokerageAndCharges ?? null,
          }
        : null,
      positions: {
        cash: cashPositions,
        fno: fnoPositions,
        openFnoCount: openFno.length,
        realisedPnl,
        unrealisedPnl,
      },
      holdings: deepCamel(val(holdings, [])),
      orders: deepCamel(val(orders, [])),
      errors,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
