import { describe, expect, it } from 'vitest';
import {
  canViewNegotiatorActivityLeaderboard,
  resolveNegotiatorActivityTarget,
} from './negotiatorActivity.js';

describe('negotiator activity authorization helpers', () => {
  it('allows leaderboard for manager roles only', () => {
    expect(canViewNegotiatorActivityLeaderboard('negotiator')).toBe(false);
    expect(canViewNegotiatorActivityLeaderboard('viewer')).toBe(false);
    expect(canViewNegotiatorActivityLeaderboard('supervisor')).toBe(true);
    expect(canViewNegotiatorActivityLeaderboard('land_acquisition_manager')).toBe(true);
    expect(canViewNegotiatorActivityLeaderboard('system_admin')).toBe(true);
  });

  it('forces negotiators to their own id and rejects other targets', () => {
    expect(
      resolveNegotiatorActivityTarget({
        role: 'negotiator',
        actorUserId: 'self',
        requestedNegotiatorId: undefined,
      }),
    ).toBe('self');
    expect(() =>
      resolveNegotiatorActivityTarget({
        role: 'negotiator',
        actorUserId: 'self',
        requestedNegotiatorId: 'other',
      }),
    ).toThrow(/permission/);
  });

  it('lets managers select another negotiator', () => {
    expect(
      resolveNegotiatorActivityTarget({
        role: 'land_acquisition_manager',
        actorUserId: 'manager',
        requestedNegotiatorId: 'negotiator-1',
      }),
    ).toBe('negotiator-1');
  });
});
