/**
 * Groww returns snake_case. The frontend contract is camelCase, so routes
 * normalise at the boundary and React never has to know about the wire format.
 */
const toCamelKey = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

export function deepCamel(value) {
  if (Array.isArray(value)) return value.map(deepCamel);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[toCamelKey(k)] = deepCamel(v);
    return out;
  }
  return value;
}
