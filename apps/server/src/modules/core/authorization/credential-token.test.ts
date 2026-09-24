import { describe, expect, it } from 'vitest';
import { issueToken, parseToken, secretMatches } from './credential-token.ts';

const PEPPER = 'p'.repeat(32);

describe('agent credential tokens', () => {
  it('round-trips an issued token and matches only its own secret', () => {
    const issued = issueToken(PEPPER);
    const parsed = parseToken(issued.token);

    expect(parsed?.publicId).toBe(issued.publicId);
    expect(secretMatches(PEPPER, parsed!.secret, issued.secretHash)).toBe(true);
    expect(secretMatches('q'.repeat(32), parsed!.secret, issued.secretHash)).toBe(false);
    expect(secretMatches(PEPPER, parseToken(issueToken(PEPPER).token)!.secret, issued.secretHash)).toBe(false);
  });

  it('rejects anything that is not exactly the token shape', () => {
    const { token } = issueToken(PEPPER);
    for (const bad of ['', 'mtr_agt_', token.slice(0, -1), `${token}x`, token.replace('mtr_agt_', 'mtr_usr_')]) {
      expect(parseToken(bad)).toBeNull();
    }
  });
});
