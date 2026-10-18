/**
 * Minimal TTL cache. Keeps us well inside Groww's per-endpoint rate limits
 * (holdings/positions/margins/orders are capped around 20 req/sec).
 *
 * Returns the cached value itself — never a spread copy — so arrays and
 * primitives survive intact.
 */
const store = new Map();

export async function cached(key, ttlMs, producer) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return hit.value;

  const value = await producer();
  store.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

export function invalidate(prefix = '') {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function cacheStats() {
  return { entries: store.size, keys: [...store.keys()] };
}
