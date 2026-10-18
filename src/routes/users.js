import { Router } from 'express';
import { listUsers, deleteUser } from '../db.js';

const router = Router();

/** GET /api/users — list all users (no password hashes). */
router.get('/', async (_req, res, next) => {
  try {
    const users = await listUsers();
    res.json({ ok: true, count: users.length, users });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/users/:id — remove a user. */
router.delete('/:id', async (req, res, next) => {
  try {
    const removed = await deleteUser(Number(req.params.id));
    if (!removed) {
      return res.status(404).json({ ok: false, error: 'User not found.' });
    }
    res.json({ ok: true, removed: true });
  } catch (err) {
    next(err);
  }
});

export default router;
