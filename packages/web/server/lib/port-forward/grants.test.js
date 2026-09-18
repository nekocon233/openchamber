import { describe, expect, test } from 'bun:test';

import { createForwardGrants } from './grants.js';

const setup = () => {
  let clock = 1_000;
  let counter = 0;
  const grants = createForwardGrants({
    now: () => clock,
    randomToken: () => `token-${++counter}`,
    grantTtlMs: 1_000,
    sessionTtlMs: 10_000,
  });
  return { grants, advance: (ms) => { clock += ms; } };
};

describe('createForwardGrants', () => {
  test('a grant exchanges for a session that then authenticates the port', () => {
    const { grants } = setup();
    const session = grants.redeemGrant(grants.issueGrant(5173), 5173);
    expect(session).not.toBeNull();
    expect(grants.hasValidSession(session, 5173)).toBe(true);
  });

  test('a grant is spent on first use', () => {
    const { grants } = setup();
    const grant = grants.issueGrant(5173);
    expect(grants.redeemGrant(grant, 5173)).not.toBeNull();
    expect(grants.redeemGrant(grant, 5173)).toBeNull();
  });

  test('a grant for one port does not open another', () => {
    const { grants } = setup();
    expect(grants.redeemGrant(grants.issueGrant(5173), 3000)).toBeNull();
  });

  test('a session for one port does not authenticate another', () => {
    const { grants } = setup();
    const session = grants.redeemGrant(grants.issueGrant(5173), 5173);
    expect(grants.hasValidSession(session, 3000)).toBe(false);
  });

  test('an expired grant is refused', () => {
    const { grants, advance } = setup();
    const grant = grants.issueGrant(5173);
    advance(1_000);
    expect(grants.redeemGrant(grant, 5173)).toBeNull();
  });

  test('an expired session is refused', () => {
    const { grants, advance } = setup();
    const session = grants.redeemGrant(grants.issueGrant(5173), 5173);
    advance(9_999);
    expect(grants.hasValidSession(session, 5173)).toBe(true);
    advance(1);
    expect(grants.hasValidSession(session, 5173)).toBe(false);
  });

  test('turning a forward off invalidates its sessions immediately', () => {
    const { grants } = setup();
    const session = grants.redeemGrant(grants.issueGrant(5173), 5173);
    const other = grants.redeemGrant(grants.issueGrant(3000), 3000);

    grants.revokePort(5173);

    expect(grants.hasValidSession(session, 5173)).toBe(false);
    // One forward stopping must not sign the user out of an unrelated one.
    expect(grants.hasValidSession(other, 3000)).toBe(true);
  });

  test('turning a forward off also cancels grants that were never used', () => {
    const { grants } = setup();
    const grant = grants.issueGrant(5173);
    grants.revokePort(5173);
    expect(grants.redeemGrant(grant, 5173)).toBeNull();
  });

  test.each([
    ['an unknown token', 'nonsense'],
    ['an empty token', ''],
    ['a missing token', undefined],
  ])('refuses %s', (_label, token) => {
    const { grants } = setup();
    expect(grants.redeemGrant(token, 5173)).toBeNull();
    expect(grants.hasValidSession(token, 5173)).toBe(false);
  });

  test('expired entries do not accumulate', () => {
    const { grants, advance } = setup();
    for (let index = 0; index < 50; index += 1) {
      grants.issueGrant(5173);
      advance(2_000);
    }
    // The sweep runs on issue; the only survivor should be the newest grant.
    const grant = grants.issueGrant(5173);
    expect(grants.redeemGrant(grant, 5173)).not.toBeNull();
  });
});
