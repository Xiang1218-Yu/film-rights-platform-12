import test from 'node:test'; import assert from 'node:assert/strict';
import { migrateLegacyApprovals } from './store.js';
import { currentStep, pendingStepsFor, projectSummary, rightsConflicts } from './domain.js';
import { approvals } from './domain.js';

test('budget summary exposes forecast variance and high risk lines', () => {
  const summary = projectSummary('PRJ-001');
  assert.equal(summary.lines.length, 4);
  assert.ok(summary.forecast > summary.planned);
  assert.equal(summary.highRiskLines.length, 1);
});

test('rights conflict engine detects overlapping licensed assets', () => {
  const conflicts = rightsConflicts('PRJ-001');
  assert.ok(conflicts.length >= 1);
  assert.ok(conflicts.some(item => item.reason.includes('音乐-同步许可')));
  assert.ok(conflicts.every(item => item.assetIdA && item.assetIdB));
});

test('todo counts are derived from routed steps and stay consistent across views', () => {
  migrateLegacyApprovals();
  const summary = projectSummary('PRJ-001');
  const steps = pendingStepsFor('PRJ-001');
  assert.deepEqual(
    Object.values(summary.pendingStepsByApprover).reduce((a, b) => a + b, 0),
    steps.length,
  );
  const apr01 = approvals.find(item => item.id === 'APR-01')!;
  assert.ok(apr01.routing.legacy);
  assert.equal(currentStep(apr01)?.approver, '财务负责人');
});
