import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_FALLBACK_APPROVER, ConfigValidationError, defaultConfig, isOverseas, route, validateRules,
  type ApprovalFacts, type RoutingConfig, type RoutingRule,
} from './routing.js';

const config: RoutingConfig = { ...defaultConfig, rules: defaultConfig.rules.map(rule => ({ ...rule, match: { ...rule.match } })) };

const budgetFacts: ApprovalFacts = { projectId: 'PRJ-001', entityType: 'budget', entityId: 'BUD-001-V3', amount: 29_070_000, variancePct: 1.57, risk: 'high' };
const masterLockFacts: ApprovalFacts = { projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-001', assetType: 'master', assetStatus: 'locked', territories: ['CN'], rightsTags: ['演员-全媒介'], overseas: false, rightsRisk: false };
const overseasFacts: ApprovalFacts = { projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-001', assetType: 'master', assetStatus: 'locked', territories: ['US', 'CA'], rightsTags: ['音乐-同步许可'], overseas: true, rightsRisk: true };

test('预算偏差路由到财务，大额同人规则去重，高风险再升级风险委员会', () => {
  const decision = route(budgetFacts, config, '制片主任');
  assert.deepEqual(decision.chain.map(step => step.approver), ['财务负责人', '风险委员会']);
  assert.equal(decision.matchedRules[0].ruleId, 'R-BUDGET-VARIANCE');
  assert.ok(decision.matchedRules[0].reason.includes('1.57%'));
  // 大额规则也命中（priority 50）但与偏差规则同人，合并为一个节点
  assert.ok(decision.matchedRules.some(rule => rule.ruleId === 'R-LARGE-AMOUNT'));
  assert.equal(decision.chain.filter(step => step.approver === '财务负责人').length, 1);
});

test('母版锁定路由到总制片人，并串接母版技术复核', () => {
  const decision = route(masterLockFacts, config, '后期制片');
  assert.deepEqual(decision.chain.map(step => step.approver), ['总制片人', '后期总监']);
  assert.ok(decision.chain[0].reason.includes('locked'));
});

test('海外版权风险由法务优先接管，且优先级位于总制片之前', () => {
  const decision = route(overseasFacts, config, '后期制片');
  assert.equal(decision.chain[0].approver, '法务负责人');
  assert.deepEqual(decision.chain.map(step => step.approver), ['法务负责人', '总制片人', '后期总监']);
  assert.ok(decision.chain[0].reason.includes('US、CA'));
});

test('stopOnMatch 截断后续低优先级规则', () => {
  const rules: RoutingRule[] = [
    ...config.rules,
    { id: 'R-FIN-STOP', name: '财务终批', enabled: true, priority: 25, match: { entityTypes: ['asset'], assetTypes: ['master'] }, approver: '财务负责人', stopOnMatch: true, reasonTemplate: '终批' },
  ];
  const decision = route(masterLockFacts, { ...config, rules }, '后期制片');
  assert.deepEqual(decision.chain.map(step => step.ruleId), ['R-MASTER-LOCK', 'R-FIN-STOP']);
});

test('申请人即审批人时按 规则升级人→默认升级人→平台兜底 逐级回避自评', () => {
  const withFallback: RoutingRule[] = [{ id: 'R1', name: '自评', enabled: true, priority: 1, match: {}, approver: '张三', fallbackApprover: '李四', reasonTemplate: 'x' }];
  let decision = route(budgetFacts, { ...config, rules: withFallback }, '张三');
  assert.deepEqual(decision.chain.map(step => step.approver), ['李四']);
  assert.ok(decision.chain[0].selfApproved);
  assert.ok(decision.chain[0].escalated);

  const withoutFallback: RoutingRule[] = [{ id: 'R1', name: '自评', enabled: true, priority: 1, match: {}, approver: '张三', reasonTemplate: 'x' }];
  decision = route(budgetFacts, { ...config, defaultFallbackApprover: '王五', rules: withoutFallback }, '张三');
  assert.equal(decision.chain[0].approver, '王五');

  decision = route(budgetFacts, { ...config, defaultFallbackApprover: '张三', rules: withoutFallback }, '张三');
  assert.equal(decision.chain[0].approver, BUILTIN_FALLBACK_APPROVER);
});

test('空规则集走兜底链，且兜底审批人不会等于申请人', () => {
  const decision = route(budgetFacts, { ...config, rules: [] }, '制片主任');
  assert.equal(decision.fallbackUsed, true);
  assert.equal(decision.chain.length, 1);
  assert.equal(decision.chain[0].approver, config.defaultFallbackApprover);
  const self = route(budgetFacts, { ...config, rules: [], defaultFallbackApprover: '制片主任' }, '制片主任');
  assert.equal(self.chain[0].approver, BUILTIN_FALLBACK_APPROVER);
});

test('运行时单条坏规则只告警跳过，不影响其余规则', () => {
  const broken = { id: 'R-BAD', enabled: true, priority: 5, approver: '某人' } as unknown as RoutingRule;
  const decision = route(budgetFacts, { ...config, rules: [broken, ...config.rules] }, '制片主任');
  assert.ok(decision.warnings.some(warning => warning.includes('R-BAD')));
  assert.ok(decision.matchedRules.some(rule => rule.ruleId === 'R-BUDGET-VARIANCE'));
});

test('validateRules 拒绝空对象、坏枚举、重复 id 并收集全部错误', () => {
  assert.throws(() => validateRules(null), ConfigValidationError);
  assert.throws(() => validateRules({ rules: null }), ConfigValidationError);
  try {
    validateRules({
      rules: [
        { id: 'X', name: '', priority: 'high', approver: '', reasonTemplate: '', match: { entityTypes: ['nope'] } },
        { id: 'X', name: 'y', priority: 1, approver: 'a', reasonTemplate: 'r', match: { minAmount: 9, maxAmount: 1 } },
      ],
    });
    assert.fail('应当抛校验错误');
  } catch (error) {
    assert.ok(error instanceof ConfigValidationError);
    assert.ok(error.errors.length >= 5, `应收集多个错误，实际 ${error.errors.length}: ${error.errors.join('|')}`);
    assert.ok(error.errors.some(message => message.includes('X') && message.includes('重复')));
  }
  // 空规则集是合法的（显式表达全部走兜底）
  assert.deepEqual(validateRules({ rules: [] }), []);
});

test('isOverseas 识别大陆地域与全球/境外标签', () => {
  assert.equal(isOverseas(['CN']), false);
  assert.equal(isOverseas(['CN', 'US']), true);
  assert.equal(isOverseas(['全球']), true);
  assert.equal(isOverseas([]), false);
});
