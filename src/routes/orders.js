import { Router } from 'express';
import { groww } from '../growwClient.js';
import { cached } from '../cache.js';
import { deepCamel } from '../util/case.js';

const router = Router();
// Matches the 3s UI refresh; see routes/dashboard.js for the upstream maths.
const TTL = 3_000;

router.get('/', async (req, res, next) => {
  try {
    const segment = String(req.query.segment || 'CASH').toUpperCase();
    const page = Number(req.query.page ?? 0);
    const pageSize = Math.min(Number(req.query.pageSize ?? 50), 100);

    const raw = await cached(`orders:${segment}:${page}:${pageSize}`, TTL, () =>
      groww.orders({ segment, page, pageSize })
    );

    // Normalise into the shape the dashboard table expects.
    const orders = deepCamel(raw).map((o) => ({
      orderId: o.growwOrderId ?? o.orderId ?? null,
      symbol: o.tradingSymbol ?? o.symbol ?? null,
      exchange: o.exchange ?? null,
      segment: o.segment ?? segment,
      side: o.transactionType ?? o.orderSide ?? null,
      quantity: o.quantity ?? null,
      filledQuantity: o.filledQuantity ?? null,
      price: o.price ?? null,
      averagePrice: o.averageFillPrice ?? o.averagePrice ?? null,
      status: o.orderStatus ?? o.status ?? null,
      orderType: o.orderType ?? null,
      product: o.product ?? null,
      validity: o.validity ?? null,
      remark: o.remark ?? null,
      createdAt: o.createdAt ?? o.orderDateTime ?? null,
    }));

    res.json({ ok: true, segment, page, pageSize, count: orders.length, orders });
  } catch (err) {
    next(err);
  }
});

router.get('/:orderId', async (req, res, next) => {
  try {
    const segment = String(req.query.segment || 'CASH').toUpperCase();
    const detail = deepCamel(await groww.orderDetail(req.params.orderId, segment));
    res.json({ ok: true, order: detail });
  } catch (err) {
    next(err);
  }
});

router.get('/:orderId/trades', async (req, res, next) => {
  try {
    const segment = String(req.query.segment || 'CASH').toUpperCase();
    const trades = deepCamel(await groww.trades(req.params.orderId, segment));
    res.json({ ok: true, trades });
  } catch (err) {
    next(err);
  }
});

export default router;
