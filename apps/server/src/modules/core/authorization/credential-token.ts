import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'mtr_agt_';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export interface IssuedToken {
  readonly token: string;
  readonly publicId: string;
  readonly secretHash: Buffer;
}

/**
 * `mtr_agt_<public_id>_<secret>` (agent-mandates §7). The secret is 32 random
 * bytes, so a keyed fast hash is correct; a password KDF would only add latency.
 */
export function issueToken(pepper: string): IssuedToken {
  const publicId = Array.from(randomBytes(12), (byte) => BASE32[byte % 32]).join('');
  const secret = randomBytes(32).toString('base64url');
  return { token: `${PREFIX}${publicId}_${secret}`, publicId, secretHash: hashSecret(pepper, secret) };
}

export function parseToken(token: string): { publicId: string; secret: string } | null {
  const match = /^mtr_agt_([a-z2-7]{12})_([A-Za-z0-9_-]{43})$/.exec(token);
  return match === null ? null : { publicId: match[1]!, secret: match[2]! };
}

export function hashSecret(pepper: string, secret: string): Buffer {
  return createHmac('sha256', pepper).update(secret).digest();
}

export function secretMatches(pepper: string, secret: string, storedHash: Buffer): boolean {
  const candidate = hashSecret(pepper, secret);
  return candidate.length === storedHash.length && timingSafeEqual(candidate, storedHash);
}
