// 可配置审批路由引擎：纯函数，不依赖仓储，API / 待办计数 / 审计 / 风险视图共用同一份决定。

export type EntityType = 'budget' | 'asset' | 'delivery';
export type AssetKind = 'master' | 'trailer' | 'poster' | 'audio' | 'subtitle';
export type AssetState = 'draft' | 'review' | 'approved' | 'locked';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type StepStatus = 'pending' | 'waiting' | 'approved' | 'rejected' | 'skipped';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** 路由决策所依据的事实；由实体数据解析，可被申请入参覆盖（例如锁定意图状态）。 */
export interface ApprovalFacts {
  projectId: string;
  entityType: EntityType;
  entityId: string;
  amount?: number;
  variancePct?: number;
  risk?: RiskLevel;
  assetType?: AssetKind;
  assetStatus?: AssetState;
  owner?: string;
  territories?: string[];
  rightsTags?: string[];
  overseas?: boolean;
  rightsRisk?: boolean;
}

export interface RuleMatch {
  projectIds?: string[];
  entityTypes?: EntityType[];
  assetTypes?: AssetKind[];
  assetStatuses?: AssetState[];
  minAmount?: number;
  maxAmount?: number;
  minVariancePct?: number;
  maxVariancePct?: number;
  minRisk?: RiskLevel;
  rightsRisk?: boolean;
  overseasOnly?: boolean;
}

export interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  /** 数字越小优先级越高；平局按规则 id 排序保证结果确定。 */
  priority: number;
  match: RuleMatch;
  /** 审批人，支持 {requestedBy} 等模板（见 renderTemplate）。 */
  approver: string;
  /** 申请人与 approver 相同（或 approver 解析失败）时的升级人。 */
  fallbackApprover?: string;
  /** 命中本条后不再评估后续低优先级规则。 */
  stopOnMatch?: boolean;
  reasonTemplate: string;
}

export interface RoutingConfig {
  version: number;
  updatedAt: string;
  updatedBy?: string;
  defaultFallbackApprover: string;
  rules: RoutingRule[];
}

export interface MatchedRule {
  ruleId: string;
  ruleName: string;
  priority: number;
  reason: string;
  hit: Record<string, string | number | boolean>;
  approver: string;
  resolvedApprover: string;
  selfApproved: boolean;
  escalated: boolean;
  stopOnMatch: boolean;
  /** 命中但审批人与更高优先级节点相同，合并到该节点，不单独产生链节点。 */
  merged?: boolean;
  mergedIntoRuleId?: string;
}

export interface RouteChainStep {
  order: number;
  approver: string;
  ruleId: string;
  ruleName: string;
  reason: string;
  selfApproved: boolean;
  escalated: boolean;
}

export interface RoutingSnapshot {
  configVersion: number;
  decidedAt: string;
  legacy?: boolean;
  fallbackUsed?: boolean;
  warnings: string[];
  rules: MatchedRule[];
  chain: RouteChainStep[];
}

export interface RouteDecision {
  facts: ApprovalFacts;
  matchedRules: MatchedRule[];
  chain: RouteChainStep[];
  fallbackUsed: boolean;
  warnings: string[];
  configVersion: number;
}

const RISK_RANK: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const ENTITY_TYPES: EntityType[] = ['budget', 'asset', 'delivery'];
const ASSET_KINDS: AssetKind[] = ['master', 'trailer', 'poster', 'audio', 'subtitle'];
const ASSET_STATES: AssetState[] = ['draft', 'review', 'approved', 'locked'];
const RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

/** 兜底兜底：连默认审批人都与申请人相同或缺失时使用，保证链永不空、永不回到申请人。 */
export const BUILTIN_FALLBACK_APPROVER = '平台值班管理员';
const LOCAL_TERRITORIES = new Set(['CN', 'CHN', '中国大陆', '中国', '内地']);

export function isOverseas(territories: string[] | undefined): boolean {
  if (!territories || territories.length === 0) return false;
  return territories.some(code => !LOCAL_TERRITORIES.has(code.trim()));
}

export function riskAtLeast(actual: RiskLevel | undefined, threshold: RiskLevel): boolean {
  return actual !== undefined && RISK_RANK[actual] >= RISK_RANK[threshold];
}

// ---------------------------------------------------------------------------
// 规则配置与校验：空/坏配置显式拒绝（加载时），运行时再对单条坏规则容错。
// ---------------------------------------------------------------------------

export const defaultConfig: RoutingConfig = {
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'system',
  defaultFallbackApprover: '运营值班经理',
  rules: [
    {
      id: 'R-LEGAL-OVERSEAS',
      name: '海外版权法务核验',
      enabled: true,
      priority: 10,
      match: { entityTypes: ['asset', 'delivery'], overseasOnly: true, rightsRisk: true },
      approver: '法务负责人',
      fallbackApprover: '法务总监',
      reasonTemplate: '实体将在境外地域 {territories} 使用，版权标签 {rightsTags} 存在跨境授权风险，转法务核验权利链与地域窗口。',
    },
    {
      id: 'R-MASTER-LOCK',
      name: '母版锁定总制片审批',
      enabled: true,
      priority: 20,
      match: { entityTypes: ['asset'], assetTypes: ['master'], assetStatuses: ['locked'] },
      approver: '总制片人',
      fallbackApprover: '制片总监',
      reasonTemplate: '{assetType} 母版申请进入 locked 状态，锁定后不可撤改，需总制片人确认交付基线。',
    },
    {
      id: 'R-MASTER-TECH',
      name: '母版技术复核',
      enabled: true,
      priority: 30,
      match: { entityTypes: ['asset'], assetTypes: ['master'] },
      approver: '后期总监',
      reasonTemplate: '{assetType} 类资产需后期总监做技术与 checksum 复核（规则 {ruleId}）。',
    },
    {
      id: 'R-BUDGET-VARIANCE',
      name: '预算偏差财务复核',
      enabled: true,
      priority: 40,
      match: { entityTypes: ['budget'], minVariancePct: 0 },
      approver: '财务负责人',
      fallbackApprover: '财务总监',
      reasonTemplate: '预算预测相对基线偏差 {variancePct}%（金额 {amount}），需财务负责人复核偏差归因。',
    },
    {
      id: 'R-LARGE-AMOUNT',
      name: '大额支出财务复核',
      enabled: true,
      priority: 50,
      match: { minAmount: 10_000_000 },
      approver: '财务负责人',
      fallbackApprover: '财务总监',
      reasonTemplate: '申请金额 {amount} 超过大额阈值 ¥10,000,000，需财务负责人复核额度与付款暴露。',
    },
    {
      id: 'R-HIGH-RISK',
      name: '高风险升级风险委员会',
      enabled: true,
      priority: 60,
      match: { minRisk: 'high' },
      approver: '风险委员会',
      reasonTemplate: '风险等级 {risk} 达到 high 及以上，升级风险委员会备案（项目 {projectId}）。',
    },
  ],
};

export class ConfigValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`审批路由配置无效：\n- ${errors.join('\n- ')}`);
    this.name = 'ConfigValidationError';
  }
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function checkEnumList<T extends string>(list: unknown, allowed: T[], label: string, errors: string[]): void {
  if (list === undefined) return; // 未设置该约束 = 不参与匹配，合法
  if (!Array.isArray(list) || list.some(item => typeof item !== 'string' || !allowed.includes(item as T))) {
    errors.push(`${label} 必须是 ${allowed.join(' / ')} 的数组`);
  }
}

/** 严格校验；空 rules 合法（走兜底链），结构错误会被拒绝并返回全部问题。 */
export function validateRules(input: unknown): RoutingRule[] {
  if (input === null || typeof input !== 'object' || !Array.isArray((input as { rules?: unknown }).rules)) {
    throw new ConfigValidationError(['配置必须是包含 rules 数组的对象（空规则集请传 rules: []）']);
  }
  const rules = (input as { rules: unknown[] }).rules;
  const errors: string[] = [];
  const seen = new Set<string>();
  rules.forEach((raw, index) => {
    const where = `rules[${index}]`;
    if (raw === null || typeof raw !== 'object') { errors.push(`${where} 不是对象`); return; }
    const rule = raw as Record<string, unknown>;
    if (typeof rule.id !== 'string' || !rule.id.trim()) errors.push(`${where}.id 必须是非空字符串`);
    else if (seen.has(rule.id)) errors.push(`${where}.id "${rule.id}" 重复`);
    else seen.add(rule.id);
    if (typeof rule.name !== 'string' || !rule.name.trim()) errors.push(`${where}(${rule.id ?? '?'}) 缺少 name`);
    if (typeof rule.priority !== 'number' || !Number.isFinite(rule.priority)) errors.push(`${where}(${rule.id ?? '?'}).priority 必须是数字`);
    if (typeof rule.approver !== 'string' || !rule.approver.trim()) errors.push(`${where}(${rule.id ?? '?'}).approver 必须是非空字符串`);
    if (rule.fallbackApprover !== undefined && (typeof rule.fallbackApprover !== 'string' || !rule.fallbackApprover.trim()))
      errors.push(`${where}(${rule.id ?? '?'}).fallbackApprover 必须是非空字符串`);
    if (typeof rule.reasonTemplate !== 'string' || !rule.reasonTemplate.trim())
      errors.push(`${where}(${rule.id ?? '?'}).reasonTemplate 必须是非空字符串，用于解释分派原因`);
    if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') errors.push(`${where}.enabled 必须是布尔值`);
    if (rule.stopOnMatch !== undefined && typeof rule.stopOnMatch !== 'boolean') errors.push(`${where}.stopOnMatch 必须是布尔值`);
    if (rule.match === null || typeof rule.match !== 'object') { errors.push(`${where}(${rule.id ?? '?'}).match 必须是对象`); return; }
    const match = rule.match as Record<string, unknown>;
    if (match.projectIds !== undefined && (!Array.isArray(match.projectIds) || match.projectIds.some(v => typeof v !== 'string')))
      errors.push(`${where}.match.projectIds 必须是字符串数组`);
    checkEnumList(match.entityTypes, ENTITY_TYPES, `${where}.match.entityTypes`, errors);
    checkEnumList(match.assetTypes, ASSET_KINDS, `${where}.match.assetTypes`, errors);
    checkEnumList(match.assetStatuses, ASSET_STATES, `${where}.match.assetStatuses`, errors);
    for (const key of ['minAmount', 'maxAmount', 'minVariancePct', 'maxVariancePct'] as const) {
      if (match[key] !== undefined && (typeof match[key] !== 'number' || !Number.isFinite(match[key])))
        errors.push(`${where}.match.${key} 必须是数字`);
    }
    if (isFiniteNumber(match.minAmount) && isFiniteNumber(match.maxAmount) && match.minAmount > match.maxAmount)
      errors.push(`${where}.match.minAmount 不能大于 maxAmount`);
    if (isFiniteNumber(match.minVariancePct) && isFiniteNumber(match.maxVariancePct) && match.minVariancePct > match.maxVariancePct)
      errors.push(`${where}.match.minVariancePct 不能大于 maxVariancePct`);
    if (match.minRisk !== undefined && (typeof match.minRisk !== 'string' || !RISK_LEVELS.includes(match.minRisk as RiskLevel)))
      errors.push(`${where}.match.minRisk 必须是 ${RISK_LEVELS.join(' / ')}`);
    if (match.rightsRisk !== undefined && typeof match.rightsRisk !== 'boolean') errors.push(`${where}.match.rightsRisk 必须是布尔值`);
    if (match.overseasOnly !== undefined && typeof match.overseasOnly !== 'boolean') errors.push(`${where}.match.overseasOnly 必须是布尔值`);
  });
  if (errors.length) throw new ConfigValidationError(errors);
  return rules as RoutingRule[];
}

// ---------------------------------------------------------------------------
// 匹配与解释
// ---------------------------------------------------------------------------

function renderTemplate(template: string, facts: ApprovalFacts, extra: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    if (key in extra) return extra[key];
    const value = (facts as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value.length ? value.join('、') : '（无）';
    if (value === undefined || value === null || value === '') return '（无）';
    return String(value);
  });
}

function describeHit(match: RuleMatch): Record<string, string | number | boolean> {
  const hit: Record<string, string | number | boolean> = {};
  if (match.projectIds?.length) hit.project = match.projectIds.join('、');
  if (match.entityTypes?.length) hit.entityType = match.entityTypes.join('、');
  if (match.assetTypes?.length) hit.assetType = match.assetTypes.join('、');
  if (match.assetStatuses?.length) hit.assetStatus = match.assetStatuses.join('、');
  if (match.minAmount !== undefined || match.maxAmount !== undefined) hit.amountRange = `[${match.minAmount ?? '-∞'}, ${match.maxAmount ?? '+∞'}]`;
  if (match.minVariancePct !== undefined || match.maxVariancePct !== undefined) hit.varianceRange = `[${match.minVariancePct ?? '-∞'}%, ${match.maxVariancePct ?? '+∞'}%]`;
  if (match.minRisk) hit.minRisk = match.minRisk;
  if (match.overseasOnly) hit.overseas = true;
  if (match.rightsRisk) hit.rightsRisk = true;
  return hit;
}

export function ruleMatches(rule: RoutingRule, facts: ApprovalFacts): boolean {
  const m = rule.match;
  if (m.projectIds?.length && !m.projectIds.includes(facts.projectId)) return false;
  if (m.entityTypes?.length && !m.entityTypes.includes(facts.entityType)) return false;
  if (m.assetTypes?.length && (!facts.assetType || !m.assetTypes.includes(facts.assetType))) return false;
  if (m.assetStatuses?.length && (!facts.assetStatus || !m.assetStatuses.includes(facts.assetStatus))) return false;
  if (m.minAmount !== undefined && (facts.amount === undefined || facts.amount < m.minAmount)) return false;
  if (m.maxAmount !== undefined && (facts.amount === undefined || facts.amount > m.maxAmount)) return false;
  if (m.minVariancePct !== undefined && (facts.variancePct === undefined || facts.variancePct < m.minVariancePct)) return false;
  if (m.maxVariancePct !== undefined && (facts.variancePct === undefined || facts.variancePct > m.maxVariancePct)) return false;
  if (m.minRisk && !riskAtLeast(facts.risk, m.minRisk)) return false;
  if (m.overseasOnly && !facts.overseas) return false;
  if (m.rightsRisk && !facts.rightsRisk) return false;
  return true;
}

function resolveApprover(
  rule: RoutingRule,
  requestedBy: string,
  configDefault: string,
): { approver: string; selfApproved: boolean; escalated: boolean } {
  const primary = rule.approver.trim();
  if (primary !== requestedBy) return { approver: primary, selfApproved: false, escalated: false };
  // 申请人即审批人：按 规则升级人 → 配置默认升级人 → 平台兜底 的顺序回避自评；换人即升级。
  for (const candidate of [rule.fallbackApprover?.trim(), configDefault.trim(), BUILTIN_FALLBACK_APPROVER]) {
    if (candidate && candidate !== requestedBy) {
      return { approver: candidate, selfApproved: true, escalated: true };
    }
  }
  return { approver: BUILTIN_FALLBACK_APPROVER, selfApproved: true, escalated: true };
}

/** 核心决定：收集全部命中规则 → 优先级排序 → stopOnMatch 截断 → 自我审批升级 → 同人去重 → 兜底。 */
export function route(facts: ApprovalFacts, config: RoutingConfig, requestedBy: string): RouteDecision {
  const warnings: string[] = [];
  const matched: RoutingRule[] = [];
  for (const raw of config.rules) {
    // 加载时已校验；运行时再隔离单条坏规则，坏配置绝不能打垮申请链路。
    try {
      if (raw === null || typeof raw !== 'object') throw new Error('规则不是对象');
      const rule = raw as RoutingRule;
      if (rule.enabled === false) continue;
      if (typeof rule.id !== 'string' || typeof rule.priority !== 'number' || typeof rule.approver !== 'string' || rule.match === null)
        throw new Error('规则缺少 id / priority / approver / match');
      if (ruleMatches(rule, facts)) matched.push(rule);
    } catch (error) {
      const id = (raw as { id?: string } | null)?.id ?? '(无 id)';
      warnings.push(`规则 ${id} 结构损坏已跳过：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  matched.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  const chosen: RoutingRule[] = [];
  for (const rule of matched) {
    chosen.push(rule);
    if (rule.stopOnMatch) break;
  }

  const matchedRules: MatchedRule[] = [];
  const chain: RouteChainStep[] = [];
  const usedApprovers = new Map<string, string>(); // approver → 首个占用它的规则 id
  for (const rule of chosen) {
    const resolved = resolveApprover(rule, requestedBy, config.defaultFallbackApprover);
    const reason = renderTemplate(rule.reasonTemplate, facts, { ruleId: rule.id, ruleName: rule.name });
    const mergedIntoRuleId = usedApprovers.get(resolved.approver);
    matchedRules.push({
      ruleId: rule.id, ruleName: rule.name, priority: rule.priority, reason,
      hit: describeHit(rule.match), approver: rule.approver,
      resolvedApprover: resolved.approver, selfApproved: resolved.selfApproved,
      escalated: resolved.escalated, stopOnMatch: !!rule.stopOnMatch,
      ...(mergedIntoRuleId ? { merged: true, mergedIntoRuleId } : {}),
    });
    if (mergedIntoRuleId) continue; // 同人多规则只在最高优先级节点审批一次
    usedApprovers.set(resolved.approver, rule.id);
    chain.push({
      order: chain.length + 1, approver: resolved.approver, ruleId: rule.id,
      ruleName: rule.name, reason, selfApproved: resolved.selfApproved, escalated: resolved.escalated,
    });
  }

  let fallbackUsed = false;
  if (chain.length === 0) {
    const approver = config.defaultFallbackApprover?.trim() && config.defaultFallbackApprover !== requestedBy
      ? config.defaultFallbackApprover.trim()
      : BUILTIN_FALLBACK_APPROVER;
    const reason = '未命中任何已启用的路由规则，使用兜底审批人。';
    matchedRules.push({
      ruleId: 'FALLBACK', ruleName: '兜底审批', priority: Number.MAX_SAFE_INTEGER, reason,
      hit: {}, approver, resolvedApprover: approver, selfApproved: approver === requestedBy,
      escalated: approver !== config.defaultFallbackApprover, stopOnMatch: false,
    });
    chain.push({ order: 1, approver, ruleId: 'FALLBACK', ruleName: '兜底审批', reason, selfApproved: approver === requestedBy, escalated: approver !== config.defaultFallbackApprover });
    fallbackUsed = true;
  }

  return { facts, matchedRules, chain, fallbackUsed, warnings, configVersion: config.version };
}
