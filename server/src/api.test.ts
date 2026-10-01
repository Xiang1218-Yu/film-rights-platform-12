import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { defaultConfig } from './routing.js';

let server: Server;
let base: string;

test.before(async () => {
  server = createApp().listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务器未绑定端口');
  base = `http://127.0.0.1:${address.port}/api`;
});
test.after(() => server.close());

const json = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
};

test('GET summary：待办计数与审批链一致，迁移后的旧审批携带规则快照与原因', async () => {
  const { status, body } = await json('/projects/PRJ-001/summary');
  assert.equal(status, 200);
  assert.ok(body.pendingApprovals >= 2);
  assert.ok(Array.isArray(body.pendingSteps));
  const stepsTotal = Object.values(body.pendingStepsByApprover as Record<string, number>).reduce((a, b) => a + b, 0);
  assert.equal(stepsTotal, body.pendingSteps.length);
  const budget = body.approvals.find((item: { id: string }) => item.id === 'APR-01');
  assert.equal(budget.approver, '财务负责人');
  assert.ok(budget.routing.legacy);
  assert.ok(budget.steps[0].reason.length > 0);
});

test('POST approvals：预算申请按偏差/金额/风险返回多节点链与命中快照', async () => {
  const { status, body } = await json('/approvals', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'PRJ-001', entityType: 'budget', entityId: 'BUD-002-V2',
      title: 'Orbit 预算复核', requestedBy: '制片主任',
    }),
  });
  assert.equal(status, 201);
  assert.deepEqual(body.approval.steps.map((step: { approver: string }) => step.approver), ['财务负责人', '风险委员会']);
  assert.ok(body.approval.routing.rules.some((rule: { ruleId: string }) => rule.ruleId === 'R-BUDGET-VARIANCE'));
});

test('POST approvals：校验失败 400、坏实体 404、重复触发 409，相同幂等键重放 200', async () => {
  const bad = await json('/approvals', { method: 'POST', body: JSON.stringify({ projectId: 'PRJ-001' }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'VALIDATION_ERROR');

  const missing = await json('/approvals', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-999', title: 'x', requestedBy: 'y' }),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'ENTITY_NOT_FOUND');

  const payload = { projectId: 'PRJ-001', entityType: 'delivery', entityId: 'DEL-HTTP-1', title: '海外交付', requestedBy: '发行部', territories: ['US'], rightsTags: ['x'], idempotencyKey: 'idem-http-1' };
  const first = await json('/approvals', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(first.status, 201);
  const replay = await json('/approvals', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.approval.id, first.body.approval.id);
  const dup = await json('/approvals', { method: 'POST', body: JSON.stringify({ ...payload, idempotencyKey: 'other' }) });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'DUPLICATE_ACTIVE_REQUEST');
});

test('PATCH 链流转：按节点推进，越权 403，拒绝后可重提；审计逐步可查', async () => {
  const created = await json('/approvals', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'PRJ-002', entityType: 'asset', entityId: 'AST-004', title: 'Orbit 母版锁定 HTTP', requestedBy: '视觉总监', assetStatus: 'locked' }),
  });
  const id = created.body.approval.id;
  const forbidden = await json(`/approvals/${id}`, { method: 'PATCH', body: JSON.stringify({ actor: '后期总监', status: 'approved' }) });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, 'FORBIDDEN_APPROVER');

  const approve1 = await json(`/approvals/${id}`, { method: 'PATCH', body: JSON.stringify({ actor: '法务负责人', status: 'approved', comment: '通过' }) });
  assert.equal(approve1.status, 200);
  assert.equal(approve1.body.approval.approver, '总制片人');

  const reject = await json(`/approvals/${id}`, { method: 'PATCH', body: JSON.stringify({ actor: '总制片人', status: 'rejected', comment: '不行' }) });
  assert.equal(reject.status, 200);
  assert.equal(reject.body.approval.status, 'rejected');

  const resubmit = await json('/approvals', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'PRJ-002', entityType: 'asset', entityId: 'AST-004', title: 'Orbit 母版锁定 HTTP v2', requestedBy: '视觉总监', assetStatus: 'locked' }),
  });
  assert.equal(resubmit.status, 201);
  assert.equal(resubmit.body.resubmitted, true);
  assert.equal(resubmit.body.approval.attempt, 2);

  const audit = await json(`/audit?entityId=AST-004&limit=20`);
  const actions = audit.body.map((event: { action: string }) => event.action);
  assert.ok(actions.includes('STEP_APPROVE'));
  assert.ok(actions.includes('STEP_REJECT'));
  assert.ok(actions.includes('RESUBMIT'));
});

test('配置：GET 生效规则；PUT 坏配置 400 且旧规则保留；PUT 合法配置热更新', async () => {
  const before = await json('/routing/rules');
  const count = before.body.rules.length;
  const bad = await json('/routing/rules', {
    method: 'PUT',
    body: JSON.stringify({ updatedBy: '管理员', rules: [{ id: 'X' }] }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'INVALID_ROUTING_CONFIG');
  assert.ok(Array.isArray(bad.body.errors));
  const unchanged = await json('/routing/rules');
  assert.equal(unchanged.body.rules.length, count);

  const updated = await json('/routing/rules', {
    method: 'PUT',
    body: JSON.stringify({
      updatedBy: '管理员',
      rules: [{ id: 'R1', name: '预算→财务', enabled: true, priority: 1, match: { entityTypes: ['budget'] }, approver: '财务负责人', reasonTemplate: '预算统一走财务（{projectId}）' }],
    }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.rules.length, 1);
  // 恢复默认，避免影响同进程内其他视图
  await json('/routing/rules', { method: 'PUT', body: JSON.stringify({ updatedBy: 'system', rules: defaultConfig.rules }) });
});

test('风险视图与路由预览共用引擎：冲突行带锁定审批链预览', async () => {
  const view = await json('/projects/PRJ-001/rights-conflicts');
  assert.equal(view.status, 200);
  assert.ok(view.body.conflicts.length >= 1);
  const withPreview = view.body.conflicts.find((row: { previewLockRouteA?: unknown }) => row.previewLockRouteA);
  assert.ok(withPreview);
  assert.ok(withPreview.previewLockRouteA.chain.some((step: { ruleId: string }) => step.ruleId === 'R-MASTER-LOCK'));

  const preview = await json('/routing/preview', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-001', requestedBy: '后期制片', overrides: { assetStatus: 'locked' } }),
  });
  assert.equal(preview.status, 200);
  assert.ok(preview.body.chain.some((step: { approver: string }) => step.approver === '总制片人'));
});

test('不存在的审批 PATCH 返回 404；非法状态返回 400', async () => {
  const notFound = await json('/approvals/APR-NOPE', { method: 'PATCH', body: JSON.stringify({ actor: 'x', status: 'approved' }) });
  assert.equal(notFound.status, 404);
  const invalid = await json('/approvals/APR-01', { method: 'PATCH', body: JSON.stringify({ actor: '财务负责人', status: 'maybe' }) });
  assert.equal(invalid.status, 400);
});
