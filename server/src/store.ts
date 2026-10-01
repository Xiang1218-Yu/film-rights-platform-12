// 审批生命周期：规则配置、幂等创建 / 拒绝重提、串行链流转、并发互斥与旧数据迁移。
import {
  approvals, auditEvents, assets, projects, resolveFacts, rightsConflicts,
  type Approval, type ApprovalStep, type AuditEvent, type FactOverrides,
} from './domain.js';
import {
  defaultConfig, route, validateRules,
  ConfigValidationError,
  type ApprovalFacts, type EntityType, type RouteChainStep, type RoutingConfig, type RoutingSnapshot,
} from './routing.js';

export { ConfigValidationError };

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
  }
}

// ---- 时钟与 id（测试可替换） ------------------------------------------------
let clock = () => new Date();
let seq = 0;
export function setClock(fn: () => Date) { clock = fn; }
const newId = (prefix: string) => `${prefix}-${clock().getTime().toString(36)}-${(seq++).toString(36)}`;
const stamp = () => clock().toISOString();

// ---- 进程内互斥：Node 单线程下串行化跨 await 的读-改-写，杜绝并发双单/双状态 ----
class Mutex {
  private queue: Promise<unknown> = Promise.resolve();
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
}
export const writeLock = new Mutex();

// ---- 规则配置（热更新，坏配置被拒绝时继续沿用当前配置） ----------------------
let config: RoutingConfig = { ...defaultConfig, rules: defaultConfig.rules.map(rule => ({ ...rule, match: { ...rule.match } })) };
export function getConfig(): RoutingConfig { return config; }

export function updateConfig(actor: string, rules: unknown): RoutingConfig {
  const valid = validateRules({ rules }); // 抛 ConfigValidationError → 当前配置不动
  config = { ...config, version: config.version + 1, updatedAt: stamp(), updatedBy: actor, rules: valid };
  auditEvents.unshift({ id: newId('AUD'), action: 'ROUTING_CONFIG_UPDATE', entity: 'routing-config', entityId: `v${config.version}`, actor, at: stamp(), details: `审批路由配置更新为 ${valid.length} 条规则（v${config.version}）` });
  return config;
}

function audit(action: string, entity: string, entityId: string, actor: string, details: string): AuditEvent {
  const event = { id: newId('AUD'), action, entity, entityId, actor, at: stamp(), details };
  auditEvents.unshift(event);
  return event;
}

function snapshotFrom(decision: ReturnType<typeof route>, legacy = false): RoutingSnapshot {
  return {
    configVersion: decision.configVersion, decidedAt: stamp(), legacy,
    fallbackUsed: decision.fallbackUsed, warnings: decision.warnings,
    rules: decision.matchedRules, chain: decision.chain,
  };
}

function stepsFromChain(chain: RouteChainStep[], seed?: { status: ApprovalStep['status']; actor?: string; comment?: string; at: string }): ApprovalStep[] {
  return chain.map((node, index) => ({
    id: newId('STP'), order: node.order, ruleId: node.ruleId, ruleName: node.ruleName,
    reason: node.reason, approver: node.approver, selfApproved: node.selfApproved, escalated: node.escalated,
    status: seed ? seed.status : index === 0 ? 'pending' : 'waiting',
    actor: seed?.actor, comment: seed?.comment, decidedAt: seed ? seed.at : undefined,
  }));
}

// ---- 旧数据迁移：为静态 approver 时代的申请补算规则链与快照（幂等） ----------
export interface MigrationReport { migrated: string[]; skipped: number }

export function migrateLegacyApprovals(): MigrationReport {
  const migrated: string[] = [];
  let skipped = 0;
  for (const item of approvals) {
    if (item.routing?.legacy || item.steps.length > 0) { skipped += 1; continue; }
    const overrides: FactOverrides = {
      amount: item.amount, variancePct: item.variancePct, risk: item.risk,
      assetStatus: item.assetStatus, territories: item.territories, rightsTags: item.rightsTags,
    };
    const facts = resolveFacts({ projectId: item.projectId, entityType: item.entityType, entityId: item.entityId, overrides });
    const decision = route(facts, config, item.requestedBy);
    item.routing = snapshotFrom(decision, true);

    if (item.status === 'pending') {
      // 保留旧办理位置：旧静态 approver 若在新链中，其之前的节点视为旧系统隐含跳过
      const legacyIndex = decision.chain.findIndex(node => node.approver === item.approver);
      const start = legacyIndex === -1 ? 0 : legacyIndex;
      item.steps = decision.chain.map((node, index) => ({
        id: newId('STP'), order: node.order, ruleId: node.ruleId, ruleName: node.ruleName,
        reason: node.reason, approver: node.approver, selfApproved: node.selfApproved, escalated: node.escalated,
        status: index < start ? 'skipped' : index === start ? 'pending' : 'waiting',
        comment: index < start ? '旧版静态审批迁移：原审批人位于链中后续节点，本步视为已隐含通过' : undefined,
      }));      if (legacyIndex === -1) item.routing.warnings.push(`旧审批人「${item.approver}」不在新规则链中，申请回到链首重新审批`);
    } else {
      const at = item.createdAt ? new Date(item.createdAt).toISOString() : stamp();
      item.steps = stepsFromChain(decision.chain, { status: 'approved', actor: item.approver, comment: item.comment, at });
    }
    item.dedupeKey = item.dedupeKey || `${item.projectId}:${item.entityType}:${item.entityId}`;
    migrated.push(item.id);
  }
  if (migrated.length) audit('ROUTING_MIGRATE', 'approval', '*', 'system', `旧版静态审批迁移：${migrated.length} 单补算规则链（${migrated.join('、')}）`);
  return { migrated, skipped };
}

// ---- 创建：输入校验 + 事实解析 + 幂等/重提 + 路由快照 ------------------------
export interface CreateApprovalInput {
  projectId: unknown; entityType: unknown; entityId: unknown; title: unknown; requestedBy: unknown;
  amount?: unknown; variancePct?: unknown; risk?: unknown; assetStatus?: unknown;
  territories?: unknown; rightsTags?: unknown; idempotencyKey?: unknown;
}

function parseCreateInput(body: CreateApprovalInput) {
  const requireString = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'VALIDATION_ERROR', `字段 ${field} 必须是非空字符串`);
    return value.trim();
  };
  const projectId = requireString(body.projectId, 'projectId');
  const entityType = requireString(body.entityType, 'entityType') as EntityType;
  if (!['budget', 'asset', 'delivery'].includes(entityType)) throw new HttpError(400, 'VALIDATION_ERROR', 'entityType 必须是 budget / asset / delivery');
  const entityId = requireString(body.entityId, 'entityId');
  const title = requireString(body.title, 'title');
  const requestedBy = requireString(body.requestedBy, 'requestedBy');
  if (!projects.some(project => project.id === projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', `项目 ${projectId} 不存在`);
  if (entityType === 'asset' && !assets.some(asset => asset.id === entityId && asset.projectId === projectId))
    throw new HttpError(404, 'ENTITY_NOT_FOUND', `资产 ${entityId} 不属于项目 ${projectId} 或不存在`);

  const overrides: FactOverrides = {};
  if (body.amount !== undefined) { if (typeof body.amount !== 'number' || body.amount < 0) throw new HttpError(400, 'VALIDATION_ERROR', 'amount 必须是非负数字'); overrides.amount = body.amount; }
  if (body.variancePct !== undefined) { if (typeof body.variancePct !== 'number') throw new HttpError(400, 'VALIDATION_ERROR', 'variancePct 必须是数字'); overrides.variancePct = body.variancePct; }
  if (body.risk !== undefined) { if (!['low', 'medium', 'high', 'critical'].includes(body.risk as string)) throw new HttpError(400, 'VALIDATION_ERROR', 'risk 必须是 low/medium/high/critical'); overrides.risk = body.risk as FactOverrides['risk']; }
  if (body.assetStatus !== undefined) { if (!['draft', 'review', 'approved', 'locked'].includes(body.assetStatus as string)) throw new HttpError(400, 'VALIDATION_ERROR', 'assetStatus 非法'); overrides.assetStatus = body.assetStatus as FactOverrides['assetStatus']; }
  if (body.territories !== undefined) { if (!Array.isArray(body.territories) || body.territories.some(v => typeof v !== 'string')) throw new HttpError(400, 'VALIDATION_ERROR', 'territories 必须是字符串数组'); overrides.territories = body.territories; }
  if (body.rightsTags !== undefined) { if (!Array.isArray(body.rightsTags) || body.rightsTags.some(v => typeof v !== 'string')) throw new HttpError(400, 'VALIDATION_ERROR', 'rightsTags 必须是字符串数组'); overrides.rightsTags = body.rightsTags; }
  const idempotencyKey = body.idempotencyKey === undefined ? undefined : requireString(body.idempotencyKey, 'idempotencyKey');
  return { projectId, entityType, entityId, title, requestedBy, overrides, idempotencyKey };
}

export interface CreateResult { approval: Approval; idempotentReplay: boolean; resubmitted: boolean }

export function createApproval(rawBody: CreateApprovalInput): CreateResult {
  const input = parseCreateInput(rawBody);
  const dedupeKey = `${input.projectId}:${input.entityType}:${input.entityId}`;
  const active = approvals.find(item => item.dedupeKey === dedupeKey && item.status === 'pending');
  if (active) {
    // 同一幂等键重放 → 成功返回原单；否则视为重复触发并拒绝
    if (input.idempotencyKey && active.idempotencyKey === input.idempotencyKey)
      return { approval: active, idempotentReplay: true, resubmitted: false };
    throw new HttpError(409, 'DUPLICATE_ACTIVE_REQUEST', `实体已有进行中的审批 ${active.id}，请勿重复触发`, { existingApprovalId: active.id });
  }

  const history = approvals
    .filter(item => item.dedupeKey === dedupeKey)
    .sort((a, b) => b.attempt - a.attempt || b.createdAt.localeCompare(a.createdAt));
  const last = history[0];
  const resubmitted = !!last && last.status === 'rejected';

  const facts = resolveFacts({ projectId: input.projectId, entityType: input.entityType, entityId: input.entityId, overrides: input.overrides });
  const decision = route(facts, config, input.requestedBy);
  const item: Approval = {
    id: newId('APR'), projectId: input.projectId, entityType: input.entityType, entityId: input.entityId,
    title: input.title, requestedBy: input.requestedBy, status: 'pending', createdAt: stamp(),
    amount: facts.amount, variancePct: facts.variancePct, risk: facts.risk, assetStatus: facts.assetStatus,
    territories: facts.territories, rightsTags: facts.rightsTags,
    attempt: last ? last.attempt + 1 : 1, replacedFromId: resubmitted ? last.id : undefined,
    dedupeKey, steps: stepsFromChain(decision.chain), routing: snapshotFrom(decision), approver: decision.chain[0].approver,
    idempotencyKey: input.idempotencyKey,
  };
  approvals.unshift(item);
  audit(resubmitted ? 'RESUBMIT' : 'CREATE', item.entityType, item.entityId, input.requestedBy,
    `${item.title}（第 ${item.attempt} 次申请${resubmitted ? `，承接被拒单 ${item.replacedFromId}` : ''}）→ 审批链：${decision.chain.map(step => `${step.order}.${step.approver}`).join(' / ')}${decision.fallbackUsed ? '（兜底）' : ''}`);
  return { approval: item, idempotentReplay: false, resubmitted };
}

// ---- 审批链流转：串行，仅当前节点审批人可操作，拒绝即终止 --------------------
export interface StepResult { approval: Approval; finished: boolean }

export function actOnStep(approvalId: string, actor: string, decision: 'approved' | 'rejected', comment = ''): StepResult {
  const item = approvals.find(approval => approval.id === approvalId);
  if (!item) throw new HttpError(404, 'APPROVAL_NOT_FOUND', `审批 ${approvalId} 不存在`);
  if (item.status !== 'pending') throw new HttpError(409, 'ALREADY_DECIDED', `审批已结束（${item.status}），不能重复操作`, { status: item.status });
  const step = item.steps.find(node => node.status === 'pending');
  if (!step) throw new HttpError(409, 'NO_PENDING_STEP', '审批没有待办节点');
  if (step.approver !== actor) throw new HttpError(403, 'FORBIDDEN_APPROVER', `当前节点审批人是「${step.approver}」，「${actor}」无权操作`, { requiredApprover: step.approver });

  step.actor = actor;
  step.comment = comment;
  step.decidedAt = stamp();
  if (decision === 'rejected') {
    step.status = 'rejected';
    item.steps.filter(node => node.status === 'waiting').forEach(node => { node.status = 'skipped'; node.comment = '前序节点驳回，后续节点自动跳过'; });
    item.status = 'rejected';
    item.comment = comment;
    item.approver = step.approver;
    audit('STEP_REJECT', item.entityType, item.entityId, actor, `第 ${step.order}/${item.steps.length} 节点「${step.ruleName}」驳回：${comment || '无备注'}`);
    audit('REJECT', item.entityType, item.entityId, actor, `${item.title} 被驳回（attempt ${item.attempt}），可修改后重新发起`);
    return { approval: item, finished: true };
  }

  step.status = 'approved';
  audit('STEP_APPROVE', item.entityType, item.entityId, actor, `第 ${step.order}/${item.steps.length} 节点「${step.ruleName}」通过：${comment || '无备注'}`);
  const next = item.steps.find(node => node.status === 'waiting');
  if (next) {
    next.status = 'pending';
    item.approver = next.approver;
    return { approval: item, finished: false };
  }
  item.status = 'approved';
  item.comment = comment;
  audit('APPROVE', item.entityType, item.entityId, actor, `${item.title} 全部 ${item.steps.length} 个节点通过${comment ? `：${comment}` : ''}`);
  return { approval: item, finished: true };
}

// ---- 路由预览（风险视图共用）：只读，不写审计 -------------------------------
export function previewRoute(facts: ApprovalFacts, requestedBy: string) {
  const decision = route(facts, config, requestedBy);
  return { ...decision, decidedAt: stamp() };
}

// ---- 风险视图：冲突 + 冲突资产若申请锁定将命中的规则（与创建同一引擎） --------
export function rightsRiskView(projectId: string) {
  const conflicts = rightsConflicts(projectId);
  return {
    conflicts: conflicts.map(conflict => {
      const previewFor = (assetId: string) => {
        const asset = assets.find(item => item.id === assetId);
        if (!asset || asset.status === 'locked') return undefined;
        const facts = resolveFacts({ projectId, entityType: 'asset', entityId: assetId, overrides: { assetStatus: 'locked' } });
        const decision = route(facts, config, asset.owner);
        return {
          requestedBy: asset.owner,
          chain: decision.chain.map(step => ({ order: step.order, approver: step.approver, ruleId: step.ruleId, ruleName: step.ruleName, reason: step.reason })),
          fallbackUsed: decision.fallbackUsed,
        };
      };
      return { ...conflict, previewLockRouteA: previewFor(conflict.assetIdA), previewLockRouteB: previewFor(conflict.assetIdB) };
    }),
  };
}
