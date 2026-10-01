import test from 'node:test';
import assert from 'node:assert/strict';
import { GLOBAL_FALLBACK_APPROVER, SELF_APPROVAL_BYPASS, routeApproval, validateRoutingConfig, type RoutingContext, type RoutingRule } from './routing.js';

const baseCtx: RoutingContext = { projectId: 'PRJ-001', entityType: 'budget', entityId: 'BUD-1', requestedBy: '制片主任', amount: 500000, variancePct: 8 };
const rule = (id: string, priority: number, chain: string[], conditions: RoutingRule['conditions'] = {}, extra: Partial<RoutingRule> = {}): RoutingRule => ({ id, name: id, priority, enabled: true, conditions, chain, ...extra });

test('rules apply in priority order and matched snapshots follow the same order', () => {
  const decision = routeApproval([rule('R-B', 20, ['乙'], { entityTypes: ['budget'] }), rule('R-A', 5, ['甲'], { entityTypes: ['budget'] })], baseCtx);
  assert.deepEqual(decision.steps.map(step => step.approver), ['甲', '乙']);
  assert.deepEqual(decision.snapshot.rules.map(item => item.ruleId), ['R-A', 'R-B']);
  assert.equal(decision.snapshot.explanations.length, 2);
});

test('equal priorities fall back to rule id order for determinism', () => {
  const decision = routeApproval([rule('R-2', 10, ['乙']), rule('R-1', 10, ['甲'])], baseCtx);
  assert.deepEqual(decision.steps.map(step => step.approver), ['甲', '乙']);
});

test('disabled rules never match', () => {
  const decision = routeApproval([rule('R-OFF', 1, ['甲'], {}, { enabled: false })], baseCtx);
  assert.deepEqual(decision.steps.map(step => step.approver), [GLOBAL_FALLBACK_APPROVER]);
});

test('the same approver appears only once across merged chains', () => {
  const decision = routeApproval([rule('R-1', 1, ['法务', '财务']), rule('R-2', 2, ['法务'])], baseCtx);
  assert.deepEqual(decision.steps.map(step => step.approver), ['法务', '财务']);
});

test('self-approval escalates to rule fallback, then global fallback, then bypass', () => {
  const ctx = { ...baseCtx, requestedBy: '制片主任' };
  const toRuleFallback = routeApproval([rule('R', 1, ['制片主任'], {}, { fallbackApprover: '财务总监' })], ctx);
  assert.deepEqual(toRuleFallback.steps.map(step => step.approver), ['财务总监']);
  assert.equal(toRuleFallback.steps[0].escalated, true);
  assert.ok(toRuleFallback.snapshot.warnings.some(warning => warning.includes('申请人相同')));
  const toGlobal = routeApproval([rule('R', 1, ['制片主任'])], ctx);
  assert.deepEqual(toGlobal.steps.map(step => step.approver), [GLOBAL_FALLBACK_APPROVER]);
  const fallbackIsSelf = routeApproval([rule('R', 1, ['制片主任'], {}, { fallbackApprover: '制片主任' })], ctx);
  assert.deepEqual(fallbackIsSelf.steps.map(step => step.approver), [GLOBAL_FALLBACK_APPROVER]);
  const committeeIsSelf = routeApproval([rule('R', 1, [GLOBAL_FALLBACK_APPROVER])], { ...ctx, requestedBy: GLOBAL_FALLBACK_APPROVER });
  assert.deepEqual(committeeIsSelf.steps.map(step => step.approver), [SELF_APPROVAL_BYPASS]);
});

test('empty config and no-match both fall back to the default chain with warnings', () => {
  const empty = routeApproval([], baseCtx);
  assert.deepEqual(empty.steps.map(step => step.approver), [GLOBAL_FALLBACK_APPROVER]);
  assert.ok(empty.snapshot.warnings.some(warning => warning.includes('为空')));
  const unmatched = routeApproval([rule('R', 1, ['甲'], { entityTypes: ['asset'] })], baseCtx);
  assert.deepEqual(unmatched.steps.map(step => step.approver), [GLOBAL_FALLBACK_APPROVER]);
  assert.ok(unmatched.snapshot.warnings.some(warning => warning.includes('没有规则命中')));
  const selfDefault = routeApproval([], { ...baseCtx, requestedBy: GLOBAL_FALLBACK_APPROVER });
  assert.deepEqual(selfDefault.steps.map(step => step.approver), [SELF_APPROVAL_BYPASS]);
});

test('every condition dimension gates matching', () => {
  const hits = (conditions: RoutingRule['conditions'], ctx: RoutingContext = baseCtx) => routeApproval([rule('R', 1, ['甲'], conditions)], ctx).snapshot.rules.length;
  assert.equal(hits({ projectIds: ['PRJ-999'] }), 0);
  assert.equal(hits({ projectIds: ['PRJ-001'] }), 1);
  assert.equal(hits({ entityTypes: ['asset'] }), 0);
  assert.equal(hits({ entityTypes: ['budget', 'asset'] }), 1);
  assert.equal(hits({ minAmount: 500001 }), 0);
  assert.equal(hits({ minAmount: 500000 }), 1);
  assert.equal(hits({ minVariancePct: 8.1 }), 0);
  assert.equal(hits({ minVariancePct: 8 }), 1);
  assert.equal(hits({ assetStatuses: ['locked'] }, { ...baseCtx, assetStatus: 'review' }), 0);
  assert.equal(hits({ assetStatuses: ['review'] }, { ...baseCtx, assetStatus: 'review' }), 1);
  assert.equal(hits({ rightsRisk: 'critical' }, { ...baseCtx, rightsRisk: 'warning' }), 0);
  assert.equal(hits({ rightsRisk: 'warning' }, { ...baseCtx, rightsRisk: 'critical' }), 1);
  assert.equal(hits({ rightsRisk: 'any' }, { ...baseCtx, rightsRisk: 'none' }), 0);
});

test('invalid config entries are dropped with issues while valid ones survive', () => {
  const { rules, issues } = validateRoutingConfig([
    { id: 'OK', name: '正常', priority: 1, enabled: true, conditions: {}, chain: ['甲'] },
    { id: 'NO-NAME', chain: ['甲'] },
    { id: 'EMPTY-CHAIN', name: '空链', chain: [] },
    { id: 'BAD-CHAIN', name: '坏链', chain: '财务' },
    { id: 'BAD-COND', name: '坏条件', chain: ['甲'], conditions: 'x' },
    { id: 'OK', name: '重复 id', chain: ['乙'] },
    'not-a-rule',
    { id: 'DEFAULTS', name: '默认值', chain: ['丙'] }
  ]);
  assert.deepEqual(rules.map(item => item.id), ['OK', 'DEFAULTS']);
  assert.equal(issues.length, 6);
  const defaults = rules.find(item => item.id === 'DEFAULTS');
  assert.equal(defaults?.priority, 100);
  assert.equal(defaults?.enabled, true);
});

test('non-array config is rejected wholesale without throwing', () => {
  assert.deepEqual(validateRoutingConfig('oops').rules, []);
  assert.equal(validateRoutingConfig('oops').issues.length, 1);
  assert.deepEqual(validateRoutingConfig(null).rules, []);
  assert.deepEqual(validateRoutingConfig(undefined).issues, []);
});
