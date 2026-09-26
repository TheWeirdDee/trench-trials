import type { EligibilityDecision } from '../src/lib/repo/eligibility';

/**
 * Test rounds are approved explicitly so the mechanics suites can play them. Used only
 * against the isolated test schema; production approval is a separate, reviewed step.
 */
export const TEST_LIVE_ELIGIBILITY: EligibilityDecision = {
  status: 'approved',
  actor: 'test_fixture',
  note: 'synthetic test fixture (test schema only)',
};
