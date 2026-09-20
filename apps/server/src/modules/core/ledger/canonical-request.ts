import { createHash } from 'node:crypto';

/**
 * Deterministic JSON for idempotency digests (§10.4).
 *
 * Two requests that mean the same thing must digest the same; two that differ
 * anywhere must not. Anything JSON would silently drop or round is refused
 * instead, because a dropped field is a retry that quietly changes money.
 */
function serialize(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return `{"$bigint":${JSON.stringify(value.toString())}}`;
    case 'number':
      if (!Number.isFinite(value)) throw new RangeError(`${String(value)} is not canonical`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
      if (value instanceof Date) return JSON.stringify(value.toISOString());

      const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${serialize(item)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`${typeof value} is not canonical`);
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

export function digestRequest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
