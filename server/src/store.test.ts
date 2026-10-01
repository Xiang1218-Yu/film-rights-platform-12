import test from 'node:test';
import assert from 'node:assert/strict';
import { approvals, auditEvents, currentStep } from './domain.js';
import { defaultConfig } from './routing.js';
import {
  actOnStep, createApproval, getConfig, HttpError, migrateLegacyApprovals, rightsRiskView,
  setClock, updateConfig, writeLock, ConfigValidationError,
} from './store.js';

let clockMs = 1_767_225_600_000; // 2026-01-01，测试时钟单调推进，保证 id/审计顺序确定
setClock(() => new Date(clockMs += 1000));

test('旧数据迁移：为静态 approver 补算规则链，保留旧办理位置，且迁移幂等', () => {
  let report = migrateLegacyApprovals();
  assert.deepEqual(report.migrated.sort(), ['APR-01', 'APR-02', 'APR-03']);
  report = migrateLegacyApprovals();
  assert.deepEqual(report.migrated, []);
  assert.equal(report.skipped, 3);

  const apr02 = approvals.find(item => item.id === 'APR-02')!;
  assert.equal(apr02.routing.legacy, true);
  assert.equal(currentStep(apr02)?.approver, '总制片人'); // 旧静态审批人保留为当前节点
  const skipped = apr02.steps[0];
  assert.equal(skipped.status, 'skipped'); // 法务（海外）在总制片之前，旧数据视为隐含跳过
  assert.ok(skipped.comment?.includes('旧版静态审批迁移'));

  const apr03 = approvals.find(item => item.id === 'APR-03')!;
  assert.ok(apr03.steps.every(step => step.status === 'approved'));
  assert.ok(auditEvents.some(event => event.action === 'ROUTING_MIGRATE'));
});

test('创建时写入路由快照；申请人即审批人时自动升级到回避人', () => {
  const { approval, idempotentReplay, resubmitted } = createApproval({
    projectId: 'PRJ-001', entityType: 'delivery', entityId: 'DEL-SELF-01',
    title: '境外音乐同步授权交付', requestedBy: '法务负责人',
    territories: ['US'], rightsTags: ['音乐-同步许可'],
  });
  assert.equal(idempotentReplay, false);
  assert.equal(resubmitted, false);
  assert.equal(approval.attempt, 1);
  assert.equal(approval.steps[0].approver, '法务总监'); // 法务负责人不能自评 → 规则升级人
  assert.equal(approval.steps[0].selfApproved, true);
  assert.equal(approval.steps[0].escalated, true);
  assert.ok(approval.routing.rules.length >= 1);
  assert.equal(approval.routing.configVersion, getConfig().version);
  assert.ok(auditEvents.some(event => event.action === 'CREATE' && event.details.includes('法务总监')));
});

test('相同幂等键重放返回原单（200 路径），无幂等键的重复触发 409', () => {
  const payload = {
    projectId: 'PRJ-001' as const, entityType: 'asset' as const, entityId: 'AST-002',
    title: '预告锁定', requestedBy: '视觉总监', assetStatus: 'locked' as const,
    territories: ['US'], rightsTags: ['演员-宣传许可'], idempotencyKey: 'key-1',
  };
  const first = createApproval(payload);
  const replay = createApproval(payload);
  assert.equal(replay.approval.id, first.approval.id);
  assert.equal(replay.idempotentReplay, true);

  assert.throws(
    () => createApproval({ ...payload, idempotencyKey: undefined }),
    (error: unknown) => error instanceof HttpError && error.status === 409 && error.code === 'DUPLICATE_ACTIVE_REQUEST',
  );
});

test('并发创建同一实体：互斥串行，第二个请求得到 409 而不是双单', async () => {
  const payload = {
    projectId: 'PRJ-001' as const, entityType: 'asset' as const, entityId: 'AST-003',
    title: '片尾曲锁定', requestedBy: '视觉总监', assetStatus: 'locked' as const,
    territories: ['US'], rightsTags: ['音乐-同步许可'],
  };
  const [r1, r2] = await Promise.allSettled([
    writeLock.runExclusive(() => createApproval(payload)),
    writeLock.runExclusive(() => createApproval(payload)),
  ]);
  assert.equal(r1.status, 'fulfilled');
  assert.equal(r2.status, 'rejected');
  if (r2.status === 'rejected') assert.ok(r2.reason instanceof HttpError && r2.reason.status === 409);
  assert.equal(approvals.filter(item => item.entityId === 'AST-003' && item.status === 'pending').length, 1);
});

test('串行链：越权 403、通过推进、节点轮换后旧审批人 403、拒绝终止且后续 skipped，随后允许重提', () => {
  // AST-004 属 PRJ-002，天然海外（全球）+ 版权标签 → 法务 → 总制片 → 后期总监
  const { approval } = createApproval({
    projectId: 'PRJ-002', entityType: 'asset', entityId: 'AST-004',
    title: 'Orbit 卫星母版锁定', requestedBy: '视觉总监', assetStatus: 'locked',
  });
  assert.deepEqual(approval.steps.map(step => step.approver), ['法务负责人', '总制片人', '后期总监']);

  // 非当前节点审批人 → 403
  assert.throws(() => actOnStep(approval.id, '总制片人', 'approved'),
    error => error instanceof HttpError && error.status === 403 && error.code === 'FORBIDDEN_APPROVER');

  let result = actOnStep(approval.id, '法务负责人', 'approved', '权利链核验通过');
  assert.equal(result.finished, false);
  assert.equal(currentStep(result.approval)?.approver, '总制片人');

  // 节点已轮换：法务再操作当前（总制片）节点 → 403，杜绝跨节点重复操作
  assert.throws(() => actOnStep(approval.id, '法务负责人', 'approved'),
    error => error instanceof HttpError && error.status === 403);

  result = actOnStep(approval.id, '总制片人', 'rejected', '母版声音终混未验收');
  assert.equal(result.finished, true);
  assert.equal(result.approval.status, 'rejected');
  assert.ok(result.approval.steps.filter(step => step.order > 2).every(step => step.status === 'skipped'));
  // 终态重复操作 → 409
  assert.throws(() => actOnStep(approval.id, '总制片人', 'rejected'),
    error => error instanceof HttpError && error.status === 409 && error.code === 'ALREADY_DECIDED');

  const again = createApproval({
    projectId: 'PRJ-002', entityType: 'asset', entityId: 'AST-004',
    title: 'Orbit 卫星母版锁定（终混已补）', requestedBy: '视觉总监', assetStatus: 'locked',
  });
  assert.equal(again.resubmitted, true);
  assert.equal(again.approval.attempt, 2);
  assert.equal(again.approval.replacedFromId, approval.id);
  assert.equal(currentStep(again.approval)?.approver, '法务负责人');
  assert.ok(auditEvents.some(event => event.action === 'RESUBMIT'));
});

test('坏配置被整体拒绝并保留旧版本，合法更新才生效', () => {
  const before = getConfig();
  assert.throws(() => updateConfig('管理员', [{ id: 'BAD' }]), ConfigValidationError);
  assert.equal(getConfig().version, before.version);
  const updated = updateConfig('管理员', [
    { id: 'R-ONLY-FIN', name: '只留财务', enabled: true, priority: 1, match: { entityTypes: ['budget'] }, approver: '财务负责人', reasonTemplate: '预算走财务' },
  ]);
  assert.equal(updated.version, before.version + 1);
  assert.equal(updated.rules.length, 1);
  assert.ok(auditEvents.some(event => event.action === 'ROUTING_CONFIG_UPDATE'));
});

test('风险视图对冲突中的未锁定资产给出锁定申请的规则链预览（与创建同一引擎）', () => {
  updateConfig('system', defaultConfig.rules); // 恢复默认配置，避免依赖用例顺序
  const view = rightsRiskView('PRJ-001');
  const row = view.conflicts.find(item => item.assetIdA === 'AST-001' || item.assetIdB === 'AST-001');
  assert.ok(row);
  const preview = row!.previewLockRouteA ?? row!.previewLockRouteB;
  assert.ok(preview);
  assert.equal(preview!.requestedBy, '后期制片');
  assert.ok(preview!.chain.some(step => step.ruleId === 'R-MASTER-LOCK' && step.approver === '总制片人'));
});
