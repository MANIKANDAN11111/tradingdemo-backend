import { Router } from 'express';
import {
  listBrokers,
  getBroker,
  createBroker,
  updateBroker,
  updateBrokerStatus,
  deleteBroker,
} from '../brokerStore.js';

const router = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** GET /api/brokers — list all brokers. */
router.get('/', wrap(async (_req, res) => {
  const brokers = await listBrokers();
  res.json({ ok: true, brokers });
}));

/** POST /api/brokers — register a new broker. */
router.post('/', wrap(async (req, res) => {
  const { name, auth_type, credentials } = req.body || {};
  const broker = await createBroker({ name, auth_type, credentials });
  res.status(201).json({ ok: true, broker });
}));

/** GET /api/brokers/:id — get a single broker. */
router.get('/:id', wrap(async (req, res) => {
  const broker = await getBroker(Number(req.params.id));
  if (!broker) return res.status(404).json({ ok: false, error: 'Broker not found.' });
  res.json({ ok: true, broker });
}));

/** PUT /api/brokers/:id — update a broker. */
router.put('/:id', wrap(async (req, res) => {
  const { name, auth_type, credentials } = req.body || {};
  const broker = await updateBroker(Number(req.params.id), { name, auth_type, credentials });
  if (!broker) return res.status(404).json({ ok: false, error: 'Broker not found.' });
  res.json({ ok: true, broker });
}));

/** POST /api/brokers/:id/status — update connection status. */
router.post('/:id/status', wrap(async (req, res) => {
  const { status, message, connectedAt } = req.body || {};
  const broker = await updateBrokerStatus(Number(req.params.id), status, message, connectedAt);
  if (!broker) return res.status(404).json({ ok: false, error: 'Broker not found.' });
  res.json({ ok: true, broker });
}));

/** DELETE /api/brokers/:id — remove a broker. */
router.delete('/:id', wrap(async (req, res) => {
  const removed = await deleteBroker(Number(req.params.id));
  if (!removed) return res.status(404).json({ ok: false, error: 'Broker not found.' });
  res.json({ ok: true, removed: true });
}));

export default router;
