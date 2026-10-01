/**
 * 审批规则路由引擎。
 * 这是分派决策的唯一来源：创建 API、待办计数、审计事件与风险视图
 * 都读取这里产出的审批链与规则快照，不允许各自实现一套分派逻辑。
 */

export type EntityType = 'budget' | 'asset' | 'delivery';
export type RightsRisk = 'none' | 'warning' | 'critical';

export interface RoutingRuleConditions {
  projectIds?: string[];                       // 限定项目，缺省表示全部项目
  entityTypes?: EntityType[];                  // 限定实体类型
  minAmount?: number;                          // 金额阈值（|金额| ≥ 阈值）
  minVariancePct?: number;                     // 预算偏差阈值（|偏差%| ≥ 阈值）
  assetStatuses?: string[];                    // 资产状态（draft/review/approved/locked）
  rightsRisk?: 'any' | 'warning' | 'critical'; // 版权风险下限
}

export interface RoutingRule {
  id: string;
  name: string;
  priority: number;          // 数字越小越优先；同优先级按 id 字典序，保证确定性
  enabled: boolean;
  conditions: RoutingRuleConditions;
  chain: string[];           // 依次审批的审批人
  fallbackApprover?: string; // 审批人与申请人相同时的升级目标
}

export interface RoutingContext {
  projectId: string;
  entityType: EntityType;
  entityId: string;
  requestedBy: string;
  amount?: number;
  variancePct?: number;
  assetStatus?: string;
  rightsRisk?: RightsRisk;
}

export interface RuleSnapshot {
  ruleId: string;
  name: string;
  priority: number;
  chain: string[];
  matched: string[];         // 命中条件的人类可读描述
}

export interface RoutedStep {
  approver: string;
  ruleId: string;
  reason: string;
  escalated: boolean;        // 是否因自审批被升级
}

export interface RoutingSnapshot {
  rules: RuleSnapshot[];
  explanations: string[];    // 控制台展示的分派原因
  warnings: string[];        // 自审批升级、兜底等非正常路径
  decidedAt: string;
  legacy: boolean;           // 旧数据迁移而来、未经引擎决策
}

export interface RoutingDecision {
  steps: RoutedStep[];
  snapshot: RoutingSnapshot;
}

export const DEFAULT_RULE_ID = 'SYS-DEFAULT';
export const LEGACY_RULE_ID = 'LEGACY-STATIC';
export const GLOBAL_FALLBACK_APPROVER = '制片委员会';
export const SELF_APPROVAL_BYPASS = '平台管理员';

export interface ConfigIssue { ruleId: string; problem: string; }

/**
 * 清洗外部规则配置。坏规则被丢弃并记录原因，绝不抛异常：
 * 空配置或全部坏掉时由 routeApproval 的系统兜底链接管。
 */
export function validateRoutingConfig(raw: unknown): { rules: RoutingRule[]; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  if (raw == null) return { rules: [], issues };
  if (!Array.isArray(raw)) {
    issues.push({ ruleId: '*', problem: '规则配置必须是数组，已忽略全部配置' });
    return { rules: [], issues };
  }
  const rules: RoutingRule[] = [];
  const seenIds = new Set<string>();
  raw.forEach((entry, index) => {
    const rule = (entry ?? {}) as Partial<RoutingRule>;
    const id = typeof rule.id === 'string' && rule.id.trim() ? rule.id : `RULE-${index}`;
    const problems: string[] = [];
    if (typeof rule.name !== 'string' || !rule.name.trim()) problems.push('缺少 name');
    if (!Array.isArray(rule.chain) || rule.chain.some(approver => typeof approver !== 'string' || !approver.trim())) problems.push('chain 必须是非空字符串数组');
    else if (rule.chain.length === 0) problems.push('chain 为空，无法生成审批链');
    if (rule.conditions != null && (typeof rule.conditions !== 'object' || Array.isArray(rule.conditions))) problems.push('conditions 必须是对象');
    if (seenIds.has(id)) problems.push('规则 id 重复');
    if (problems.length) { issues.push({ ruleId: id, problem: problems.join('；') }); return; }
    seenIds.add(id);
    rules.push({
      id,
      name: (rule.name as string).trim(),
      priority: typeof rule.priority === 'number' && Number.isFinite(rule.priority) ? rule.priority : 100,
      enabled: typeof rule.enabled === 'boolean' ? rule.enabled : true,
      conditions: (rule.conditions ?? {}) as RoutingRuleConditions,
      chain: (rule.chain as string[]).map(approver => approver.trim()),
      fallbackApprover: typeof rule.fallbackApprover === 'string' && rule.fallbackApprover.trim() ? rule.fallbackApprover.trim() : undefined
    });
  });
  return { rules, issues };
}

const RISK_ORDER: Record<RightsRisk, number> = { none: 0, warning: 1, critical: 2 };

/** 返回命中条件描述；任一声明的条件不满足则返回 null。 */
function matchConditions(conditions: RoutingRuleConditions, ctx: RoutingContext): string[] | null {
  const matched: string[] = [];
  if (conditions.projectIds?.length) {
    if (!conditions.projectIds.includes(ctx.projectId)) return null;
    matched.push(`项目 ${ctx.projectId}`);
  }
  if (conditions.entityTypes?.length) {
    if (!conditions.entityTypes.includes(ctx.entityType)) return null;
    matched.push(`类型 ${ctx.entityType}`);
  }
  if (conditions.minAmount != null) {
    const amount = Math.abs(ctx.amount ?? 0);
    if (amount < conditions.minAmount) return null;
    matched.push(`金额 ${amount} ≥ ${conditions.minAmount}`);
  }
  if (conditions.minVariancePct != null) {
    const variance = Math.abs(ctx.variancePct ?? 0);
    if (variance < conditions.minVariancePct) return null;
    matched.push(`|偏差| ${variance.toFixed(1)}% ≥ ${conditions.minVariancePct}%`);
  }
  if (conditions.assetStatuses?.length) {
    if (!ctx.assetStatus || !conditions.assetStatuses.includes(ctx.assetStatus)) return null;
    matched.push(`资产状态 ${ctx.assetStatus}`);
  }
  if (conditions.rightsRisk) {
    const required = conditions.rightsRisk === 'any' ? 1 : RISK_ORDER[conditions.rightsRisk];
    if (RISK_ORDER[ctx.rightsRisk ?? 'none'] < required) return null;
    matched.push(`版权风险 ${ctx.rightsRisk ?? 'none'} ≥ ${conditions.rightsRisk}`);
  }
  return matched;
}

/** 申请人与审批人相同时的升级目标：规则级 fallback → 全局兜底 → 平台管理员。 */
function escalate(approver: string, rule: RoutingRule, requestedBy: string): string {
  const fallback = rule.fallbackApprover && rule.fallbackApprover !== requestedBy ? rule.fallbackApprover : GLOBAL_FALLBACK_APPROVER;
  return fallback === requestedBy ? SELF_APPROVAL_BYPASS : fallback;
}

/**
 * 按上下文计算审批链与规则快照。纯函数，不读写任何存储。
 * 步骤合并规则：按优先级展开命中规则的 chain，同一审批人只保留首次出现。
 */
export function routeApproval(rules: RoutingRule[], ctx: RoutingContext, decidedAt = new Date()): RoutingDecision {
  const ordered = [...rules]
    .filter(rule => rule.enabled)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const snapshotRules: RuleSnapshot[] = [];
  const explanations: string[] = [];
  const warnings: string[] = [];
  const steps: RoutedStep[] = [];
  const queued = new Set<string>();
  const pushStep = (approver: string, ruleId: string, reason: string, escalated: boolean) => {
    if (queued.has(approver)) return;
    queued.add(approver);
    steps.push({ approver, ruleId, reason, escalated });
  };

  for (const rule of ordered) {
    const matched = matchConditions(rule.conditions, ctx);
    if (!matched) continue;
    snapshotRules.push({ ruleId: rule.id, name: rule.name, priority: rule.priority, chain: [...rule.chain], matched });
    explanations.push(`命中「${rule.name}」(优先级 ${rule.priority})：${matched.length ? matched.join('、') : '无条件限制'}`);
    for (const approver of rule.chain) {
      if (approver === ctx.requestedBy) {
        const target = escalate(approver, rule, ctx.requestedBy);
        warnings.push(`「${rule.name}」指定的审批人 ${approver} 与申请人相同，已升级为 ${target}`);
        pushStep(target, rule.id, `规则「${rule.name}」指定 ${approver}，因与申请人相同升级为 ${target}`, true);
      } else {
        pushStep(approver, rule.id, `规则「${rule.name}」指定`, false);
      }
    }
  }

  if (!steps.length) {
    const approver = ctx.requestedBy === GLOBAL_FALLBACK_APPROVER ? SELF_APPROVAL_BYPASS : GLOBAL_FALLBACK_APPROVER;
    warnings.push(rules.length ? '没有规则命中该申请，已使用系统默认审批人' : '路由规则配置为空，已使用系统默认审批人');
    explanations.push('未命中任何路由规则，使用内置默认审批链');
    pushStep(approver, DEFAULT_RULE_ID, '系统默认兜底规则（无规则命中）', false);
  }

  return { steps, snapshot: { rules: snapshotRules, explanations, warnings, decidedAt: decidedAt.toISOString(), legacy: false } };
}
