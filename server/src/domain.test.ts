import test from 'node:test';
import assert from 'node:assert/strict';
import { approve, approvals, auditEvents, createApproval, projectSummary, resubmitApproval, rightsConflicts } from './domain.js';

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
});

test('seed approvals are routed by the engine and keep the rule snapshot', () => {
  const budget = approvals.find(item => item.id === 'APR-01');
  assert.deepEqual(budget?.steps.map(step => step.approver), ['财务负责人', '财务总监']);
  assert.ok(budget?.routing.rules.some(item => item.ruleId === 'R-BUDGET-VARIANCE'));
  assert.ok(budget?.routing.explanations.length >= 1);
  const master = approvals.find(item => item.id === 'APR-02');
  assert.deepEqual(master?.steps.map(step => step.approver), ['法务负责人', '总制片人']);
  assert.equal(master?.routing.rules.length, 2);
});

test('legacy static approvals are migrated to a single-step chain marked legacy', () => {
  const legacy = approvals.find(item => item.id === 'APR-03');
  assert.equal(legacy?.routing.legacy, true);
  assert.deepEqual(legacy?.steps.map(step => step.approver), ['法务负责人']);
  assert.equal(legacy?.steps[0].status, 'approved');
  assert.ok(legacy?.routing.warnings.length >= 1);
});

test('approval chain advances step by step and writes audit events', () => {
  const before = auditEvents.length;
  const first = approve('APR-01', 'approved', '财务负责人已复核');
  assert.equal(first?.status, 'pending');
  assert.equal(first?.approver, '财务总监');
  const second = approve('APR-01', 'approved', '终审通过');
  assert.equal(second?.status, 'approved');
  assert.ok(second?.steps.every(step => step.status === 'approved'));
  assert.equal(auditEvents.length, before + 2);
  const again = approve('APR-01', 'rejected', '重复操作');
  assert.equal(again?.status, 'approved');
  assert.equal(auditEvents.length, before + 2);
});

test('duplicate submissions for the same entity return the open application', () => {
  const draft = { projectId: 'PRJ-001', entityType: 'asset' as const, entityId: 'AST-002', title: '预告片上线确认', requestedBy: '营销部' };
  const first = createApproval(draft);
  assert.equal(first.deduplicated, false);
  assert.deepEqual(first.approval.steps.map(step => step.approver), ['制片委员会']);
  assert.ok(first.approval.routing.warnings.some(warning => warning.includes('默认')));
  const again = createApproval(draft);
  assert.equal(again.deduplicated, true);
  assert.equal(again.approval.id, first.approval.id);
});

test('idempotency keys deduplicate retried creates', () => {
  const draft = { projectId: 'PRJ-001', entityType: 'delivery' as const, entityId: 'DEL-100', title: '平台交付包', requestedBy: '发行部', idempotencyKey: 'KEY-DEL-100' };
  const first = createApproval(draft);
  const retry = createApproval({ ...draft, title: '改名重试' });
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.approval.id, first.approval.id);
});

test('concurrent creates for the same entity produce a single application', async () => {
  const draft = { projectId: 'PRJ-002', entityType: 'budget' as const, entityId: 'BUD-002-V2', title: '跨国拍摄超支预案', requestedBy: '制片主任' };
  const results = await Promise.all(Array.from({ length: 5 }, () => Promise.resolve(createApproval(draft))));
  assert.equal(new Set(results.map(result => result.approval.id)).size, 1);
  assert.equal(results.filter(result => result.deduplicated).length, 4);
});

test('self-approval is escalated and the warning lands on the snapshot', () => {
  const { approval } = createApproval({ projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-003', title: '片尾曲版权确认', requestedBy: '法务负责人' });
  assert.notEqual(approval.steps[0].approver, '法务负责人');
  assert.equal(approval.steps[0].approver, '法务总监');
  assert.equal(approval.steps[0].escalated, true);
  assert.ok(approval.routing.warnings.some(warning => warning.includes('申请人相同')));
});

test('rejected applications resubmit with a fresh routing snapshot and bumped revision', () => {
  const { approval } = createApproval({ projectId: 'PRJ-002', entityType: 'delivery', entityId: 'DEL-200', title: '欧洲节展交付', requestedBy: '发行部' });
  assert.deepEqual(approval.steps.map(step => step.approver), ['法务负责人', '发行总监']);
  approve(approval.id, 'rejected', '缺少授权凭证');
  assert.equal(approval.status, 'rejected');
  const again = resubmitApproval(approval.id);
  assert.equal(again?.status, 'pending');
  assert.equal(again?.revision, 2);
  assert.equal(again?.currentStepIndex, 0);
  assert.ok(again?.steps.every(step => step.status === 'pending'));
  const duplicate = createApproval({ projectId: 'PRJ-002', entityType: 'delivery', entityId: 'DEL-200', title: '重复提交', requestedBy: '发行部' });
  assert.equal(duplicate.deduplicated, true);
});

test('resubmit is rejected for applications that are not in rejected state', () => {
  assert.equal(resubmitApproval('APR-02'), undefined);
  assert.equal(resubmitApproval('APR-404'), undefined);
});

test('pending todo count shares the same routed approvals as the queue', () => {
  const before = projectSummary('PRJ-001').pendingApprovals;
  createApproval({ projectId: 'PRJ-001', entityType: 'budget', entityId: 'BUD-001-V4', title: 'V4 预算调整', requestedBy: '制片部' });
  const summary = projectSummary('PRJ-001');
  assert.equal(summary.pendingApprovals, before + 1);
  assert.equal(summary.pendingApprovals, summary.approvals.filter(item => item.status === 'pending').length);
});
