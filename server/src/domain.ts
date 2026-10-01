import { GLOBAL_FALLBACK_APPROVER, LEGACY_RULE_ID, routeApproval, validateRoutingConfig, type EntityType, type RightsRisk, type RoutingContext, type RoutingRule, type RoutingSnapshot } from './routing.js';

export type ProjectStatus = 'development' | 'production' | 'post' | 'delivered';
export type AssetType = 'master' | 'trailer' | 'poster' | 'audio' | 'subtitle';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type { EntityType, RightsRisk, RoutingRule, RoutingSnapshot } from './routing.js';

export interface Project { id: string; code: string; title: string; season: number; status: ProjectStatus; currency: string; budgetVersionId: string; deliveryDate: string; }
export interface BudgetLine { id: string; projectId: string; category: string; subcategory: string; planned: number; committed: number; actual: number; forecast: number; owner: string; risk: 'low' | 'medium' | 'high'; }
export interface Contract { id: string; projectId: string; vendor: string; scope: string; ceiling: number; committed: number; paid: number; milestones: { name: string; due: string; amount: number; status: 'open' | 'invoiced' | 'paid' }[]; }
export interface Asset { id: string; projectId: string; name: string; type: AssetType; version: number; status: 'draft' | 'review' | 'approved' | 'locked'; owner: string; checksum: string; territories: string[]; platforms: string[]; availableFrom: string; availableTo: string; rightsTags: string[]; }

export interface ApprovalStep {
  approver: string;
  ruleId: string;
  reason: string;            // 控制台展示：该步由哪条规则分派
  escalated: boolean;        // 因申请人与审批人相同被升级
  status: 'pending' | 'approved' | 'rejected' | 'skipped';
  actedAt?: string;
  comment?: string;
}
export interface Approval {
  id: string; projectId: string; entityType: EntityType; entityId: string; title: string; requestedBy: string;
  status: ApprovalStatus;
  approver: string;          // 派生字段：当前步骤审批人，兼容旧视图
  steps: ApprovalStep[]; currentStepIndex: number;
  routing: RoutingSnapshot;  // 创建/重提时的规则快照，决定之后不再随规则变化
  revision: number;          // 拒绝重提次数，首次为 1
  idempotencyKey?: string;
  createdAt: string; comment?: string;
}
export interface AuditEvent { id: string; action: string; entity: string; entityId: string; actor: string; at: string; details: string; }

const now = Date.now();
const iso = (days: number) => new Date(now + days * 86400000).toISOString().slice(0, 10);

export const projects: Project[] = [
  { id: 'PRJ-001', code: 'NORTHSTAR-S1', title: 'Northstar / 北境回声', season: 1, status: 'post', currency: 'CNY', budgetVersionId: 'BUD-001-V3', deliveryDate: iso(44) },
  { id: 'PRJ-002', code: 'ORBIT-DOC', title: 'Orbit / 轨道之外', season: 1, status: 'production', currency: 'CNY', budgetVersionId: 'BUD-002-V2', deliveryDate: iso(126) }
];
export const budgetLines: BudgetLine[] = [
  { id: 'BL-101', projectId: 'PRJ-001', category: '制作', subcategory: '主演与主创', planned: 12800000, committed: 11200000, actual: 10400000, forecast: 13100000, owner: '制片部', risk: 'medium' },
  { id: 'BL-102', projectId: 'PRJ-001', category: '制作', subcategory: '摄影器材与场地', planned: 6800000, committed: 6400000, actual: 5980000, forecast: 7020000, owner: '现场制片', risk: 'low' },
  { id: 'BL-103', projectId: 'PRJ-001', category: '后期', subcategory: '调色、DIT、母版', planned: 5400000, committed: 4300000, actual: 2800000, forecast: 5750000, owner: '后期制片', risk: 'high' },
  { id: 'BL-104', projectId: 'PRJ-001', category: '宣发', subcategory: '预告片与物料', planned: 3600000, committed: 1900000, actual: 1240000, forecast: 3200000, owner: '营销部', risk: 'medium' },
  { id: 'BL-201', projectId: 'PRJ-002', category: '制作', subcategory: '跨国拍摄', planned: 9200000, committed: 5100000, actual: 3300000, forecast: 9000000, owner: '制片部', risk: 'medium' }
];
export const contracts: Contract[] = [
  { id: 'CTR-01', projectId: 'PRJ-001', vendor: '曜石后期制作', scope: '4K HDR 调色、声音、DCP 母版', ceiling: 5200000, committed: 4300000, paid: 2300000, milestones: [{ name: '锁剪交付', due: iso(8), amount: 1200000, status: 'invoiced' }, { name: '母版验收', due: iso(36), amount: 2000000, status: 'open' }] },
  { id: 'CTR-02', projectId: 'PRJ-001', vendor: '远景国际版权', scope: '北美与欧洲音乐同步许可', ceiling: 880000, committed: 880000, paid: 440000, milestones: [{ name: '签署', due: iso(-16), amount: 440000, status: 'paid' }, { name: '交付版权证明', due: iso(4), amount: 440000, status: 'invoiced' }] },
  { id: 'CTR-03', projectId: 'PRJ-002', vendor: '云帧视觉', scope: '纪录片航拍与卫星素材', ceiling: 1600000, committed: 1100000, paid: 600000, milestones: [{ name: '素材包一', due: iso(20), amount: 500000, status: 'open' }] }
];
export const assets: Asset[] = [
  { id: 'AST-001', projectId: 'PRJ-001', name: '北境回声 S01E01 4K HDR Master', type: 'master', version: 7, status: 'review', owner: '后期制片', checksum: 'sha256:91b7…e2a1', territories: ['CN', 'HK', 'SG'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-2), availableTo: iso(730), rightsTags: ['音乐-同步许可', '演员-全媒介'] },
  { id: 'AST-002', projectId: 'PRJ-001', name: '主预告 90s / Cut A', type: 'trailer', version: 4, status: 'approved', owner: '营销部', checksum: 'sha256:42ca…9b02', territories: ['CN'], platforms: ['StreamBox', '短视频'], availableFrom: iso(6), availableTo: iso(180), rightsTags: ['演员-宣传许可'] },
  { id: 'AST-003', projectId: 'PRJ-001', name: '片尾曲 / Winter Signal', type: 'audio', version: 2, status: 'locked', owner: '音乐版权', checksum: 'sha256:113c…78f0', territories: ['CN', 'US', 'CA'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-40), availableTo: iso(52), rightsTags: ['音乐-同步许可'] },
  { id: 'AST-004', projectId: 'PRJ-002', name: 'Orbit E02 Satellite Plates', type: 'master', version: 3, status: 'review', owner: '视觉总监', checksum: 'sha256:8a10…4a9d', territories: ['全球'], platforms: ['影院'], availableFrom: iso(18), availableTo: iso(365), rightsTags: ['航拍-编辑许可'] }
];

/**
 * 路由规则配置。生产环境应来自数据库/配置中心，此处为种子；
 * 任何坏规则都会在启动时被 validateRoutingConfig 剔除并记入 routingConfigIssues。
 */
const RAW_ROUTING_RULES: unknown[] = [
  { id: 'R-RIGHTS-LEGAL', name: '版权风险法务会签', priority: 5, enabled: true, conditions: { entityTypes: ['asset', 'delivery'], rightsRisk: 'warning' }, chain: ['法务负责人'], fallbackApprover: '法务总监' },
  { id: 'R-BUDGET-VARIANCE', name: '预算偏差财务复核', priority: 10, enabled: true, conditions: { entityTypes: ['budget'], minVariancePct: 1.5 }, chain: ['财务负责人', '财务总监'], fallbackApprover: '财务总监' },
  { id: 'R-MASTER-LOCK', name: '母版送审/锁定总制片审批', priority: 10, enabled: true, conditions: { entityTypes: ['asset'], assetStatuses: ['review', 'locked'] }, chain: ['总制片人'] },
  { id: 'R-BUDGET-BIGAMOUNT', name: '大额偏差双人复核', priority: 20, enabled: true, conditions: { entityTypes: ['budget'], minAmount: 1000000 }, chain: ['财务总监'] },
  { id: 'R-ORBIT-DELIVERY', name: 'Orbit 海外交付法务加签', priority: 1, enabled: true, conditions: { projectIds: ['PRJ-002'], entityTypes: ['delivery'] }, chain: ['法务负责人', '发行总监'] }
];
const routingConfig = validateRoutingConfig(RAW_ROUTING_RULES);
export const routingRules: RoutingRule[] = routingConfig.rules;
export const routingConfigIssues = routingConfig.issues;

export function rightsConflicts(projectId = projects[0].id) {
  const list = assets.filter(asset => asset.projectId === projectId);
  const conflicts: { severity: 'critical' | 'warning'; assetA: string; assetB: string; reason: string }[] = [];
  for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
    const a = list[i], b = list[j];
    const sameTag = a.rightsTags.some(tag => b.rightsTags.includes(tag));
    const sameTerritory = a.territories.includes('全球') || b.territories.includes('全球') || a.territories.some(territory => b.territories.includes(territory));
    if (sameTag && sameTerritory && a.availableTo >= b.availableFrom && b.availableTo >= a.availableFrom) conflicts.push({ severity: a.status === 'locked' || b.status === 'locked' ? 'critical' : 'warning', assetA: a.name, assetB: b.name, reason: `同一授权标签在重叠窗口内覆盖相同地域：${a.rightsTags.filter(tag => b.rightsTags.includes(tag)).join('、')}` });
  }
  return conflicts;
}

export interface ApprovalDraft {
  projectId: string; entityType: EntityType; entityId: string; title: string; requestedBy: string;
  amount?: number; variancePct?: number; assetStatus?: string; rightsRisk?: RightsRisk; idempotencyKey?: string;
}

/**
 * 从领域数据推导路由上下文：预算申请带项目偏差，资产申请带资产状态与版权风险，
 * 交付申请带项目级版权风险。调用方显式传入的字段优先于推导值。
 */
export function buildRoutingContext(draft: Pick<ApprovalDraft, 'projectId' | 'entityType' | 'entityId' | 'requestedBy'> & Partial<ApprovalDraft>): RoutingContext {
  const ctx: RoutingContext = { projectId: draft.projectId, entityType: draft.entityType, entityId: draft.entityId, requestedBy: draft.requestedBy, rightsRisk: 'none' };
  if (draft.entityType === 'budget') {
    const lines = budgetLines.filter(line => line.projectId === draft.projectId);
    const planned = lines.reduce((sum, line) => sum + line.planned, 0);
    const forecast = lines.reduce((sum, line) => sum + line.forecast, 0);
    ctx.amount = Math.abs(forecast - planned);
    ctx.variancePct = planned ? ((forecast - planned) / planned) * 100 : 0;
  }
  if (draft.entityType === 'asset') {
    const asset = assets.find(item => item.id === draft.entityId);
    if (asset) {
      ctx.assetStatus = asset.status;
      const related = rightsConflicts(draft.projectId).filter(conflict => conflict.assetA === asset.name || conflict.assetB === asset.name);
      ctx.rightsRisk = related.some(conflict => conflict.severity === 'critical') ? 'critical' : related.length ? 'warning' : 'none';
    }
  }
  if (draft.entityType === 'delivery') {
    const conflicts = rightsConflicts(draft.projectId);
    ctx.rightsRisk = conflicts.some(conflict => conflict.severity === 'critical') ? 'critical' : conflicts.length ? 'warning' : 'none';
  }
  if (draft.amount != null) ctx.amount = draft.amount;
  if (draft.variancePct != null) ctx.variancePct = draft.variancePct;
  if (draft.assetStatus) ctx.assetStatus = draft.assetStatus;
  if (draft.rightsRisk) ctx.rightsRisk = draft.rightsRisk;
  return ctx;
}

function seedApproval(id: string, draft: ApprovalDraft, createdAt: string): Approval {
  const decision = routeApproval(routingRules, buildRoutingContext(draft));
  const steps: ApprovalStep[] = decision.steps.map(step => ({ ...step, status: 'pending' }));
  return { id, projectId: draft.projectId, entityType: draft.entityType, entityId: draft.entityId, title: draft.title, requestedBy: draft.requestedBy, status: 'pending', approver: steps[0].approver, steps, currentStepIndex: 0, routing: decision.snapshot, revision: 1, createdAt };
}

export const approvals: Approval[] = [
  seedApproval('APR-01', { projectId: 'PRJ-001', entityType: 'budget', entityId: 'BUD-001-V3', title: '后期超支预案 V3', requestedBy: '制片主任' }, iso(-1)),
  seedApproval('APR-02', { projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-001', title: 'E01 最终母版锁定', requestedBy: '后期制片' }, iso(-2)),
  // 旧模型遗留数据：只有静态 approver，无 steps/routing，由 migrateLegacyApprovals 在启动时迁移
  { id: 'APR-03', projectId: 'PRJ-002', entityType: 'delivery', entityId: 'DEL-007', title: '海外节展交付包', requestedBy: '发行部', status: 'approved', approver: '法务负责人', createdAt: iso(-5), comment: '已补充航拍授权凭证' } as Approval
];
export const auditEvents: AuditEvent[] = [{ id: 'AUD-01', action: 'CREATE', entity: 'budget', entityId: 'BUD-001-V3', actor: '制片主任', at: new Date(now - 86400000).toISOString(), details: '从 V2 复制并调整后期科目' }];

/**
 * 把规则路由上线前的静态审批（只有 approver 字段）迁移为单步审批链。
 * 幂等：已带 steps + routing 的记录原样跳过；可反复执行。
 */
export function migrateLegacyApprovals(list: Approval[] = approvals) {
  for (const item of list) {
    if (Array.isArray(item.steps) && item.steps.length && item.routing) continue;
    const staticApprover = item.approver || GLOBAL_FALLBACK_APPROVER;
    const done = item.status !== 'pending';
    item.steps = [{ approver: staticApprover, ruleId: LEGACY_RULE_ID, reason: '旧数据迁移：规则路由上线前的静态审批人', escalated: false, status: done ? item.status : 'pending', actedAt: done ? item.createdAt : undefined, comment: item.comment }];
    item.currentStepIndex = 0;
    item.routing = { rules: [], explanations: [`迁移自静态审批模型，原审批人 ${staticApprover} 保留为单步审批链`], warnings: ['该申请创建于规则路由上线前，未记录规则快照'], decidedAt: item.createdAt, legacy: true };
    item.revision = item.revision ?? 1;
  }
}
migrateLegacyApprovals();

export function projectSummary(projectId = projects[0].id) {
  const lines = budgetLines.filter(line => line.projectId === projectId);
  const projectContracts = contracts.filter(contract => contract.projectId === projectId);
  const projectAssets = assets.filter(asset => asset.projectId === projectId);
  const projectApprovals = approvals.filter(approval => approval.projectId === projectId);
  const planned = lines.reduce((sum, line) => sum + line.planned, 0);
  const forecast = lines.reduce((sum, line) => sum + line.forecast, 0);
  const actual = lines.reduce((sum, line) => sum + line.actual, 0);
  return { project: projects.find(project => project.id === projectId), planned, forecast, actual, variance: forecast - planned, utilization: planned ? actual / planned : 0, committed: lines.reduce((sum, line) => sum + line.committed, 0), contractExposure: projectContracts.reduce((sum, contract) => sum + contract.ceiling, 0), assetCount: projectAssets.length, pendingApprovals: projectApprovals.filter(item => item.status === 'pending').length, highRiskLines: lines.filter(line => line.risk === 'high'), lines, contracts: projectContracts, assets: projectAssets, approvals: projectApprovals };
}

let auditSeq = 0;
function nextAuditId() { auditSeq += 1; return `AUD-${Date.now()}-${auditSeq}`; }
function nextApprovalId() {
  const max = approvals.reduce((n, item) => { const match = /^APR-(\d+)$/.exec(item.id); return match ? Math.max(n, Number(match[1])) : n; }, 0);
  return `APR-${String(max + 1).padStart(2, '0')}`;
}

/**
 * 按当前步骤推进审批链：通过则流转到下一步，最后一步通过后整体通过；
 * 任一步驳回即整体驳回。已完结的申请幂等返回，不重复写审计。
 */
export function approve(id: string, status: ApprovalStatus, comment = '', actor?: string) {
  const item = approvals.find(approval => approval.id === id);
  if (!item) return undefined;
  if (item.status !== 'pending') return item;
  const stepIndex = item.currentStepIndex;
  const step = item.steps[stepIndex];
  const approver = actor || step?.approver || '当前审批人';
  if (step) { step.status = status; step.actedAt = new Date().toISOString(); step.comment = comment || undefined; }
  if (status === 'rejected') {
    item.status = 'rejected';
    item.comment = comment;
  } else {
    const next = item.steps.findIndex((candidate, index) => index > stepIndex && candidate.status === 'pending');
    if (next === -1) { item.status = 'approved'; item.comment = comment; } else { item.currentStepIndex = next; }
  }
  if (item.status === 'pending') item.approver = item.steps[item.currentStepIndex].approver;
  auditEvents.unshift({ id: nextAuditId(), action: status.toUpperCase(), entity: item.entityType, entityId: item.entityId, actor: approver, at: new Date().toISOString(), details: comment || `${item.title} 第 ${stepIndex + 1}/${item.steps.length} 步已${status === 'approved' ? '通过' : '驳回'}` });
  return item;
}

export interface CreateApprovalResult { approval: Approval; deduplicated: boolean; }

/**
 * 创建申请并经路由引擎生成审批链。幂等保证（检查与插入在同一同步块内，
 * 并发请求安全）：同一 idempotencyKey 直接返回原申请；同一实体已有
 * 待审批申请时返回既有申请而不是重复创建。
 */
export function createApproval(draft: ApprovalDraft): CreateApprovalResult {
  if (draft.idempotencyKey) {
    const byKey = approvals.find(item => item.idempotencyKey === draft.idempotencyKey);
    if (byKey) return { approval: byKey, deduplicated: true };
  }
  const open = approvals.find(item => item.projectId === draft.projectId && item.entityType === draft.entityType && item.entityId === draft.entityId && item.status === 'pending');
  if (open) return { approval: open, deduplicated: true };
  const decision = routeApproval(routingRules, buildRoutingContext(draft));
  const steps: ApprovalStep[] = decision.steps.map(step => ({ ...step, status: 'pending' }));
  const approval: Approval = { id: nextApprovalId(), projectId: draft.projectId, entityType: draft.entityType, entityId: draft.entityId, title: draft.title, requestedBy: draft.requestedBy, status: 'pending', approver: steps[0].approver, steps, currentStepIndex: 0, routing: decision.snapshot, revision: 1, idempotencyKey: draft.idempotencyKey, createdAt: new Date().toISOString() };
  approvals.unshift(approval);
  auditEvents.unshift({ id: nextAuditId(), action: 'CREATE', entity: draft.entityType, entityId: draft.entityId, actor: draft.requestedBy, at: new Date().toISOString(), details: `${draft.title} 已提交，命中 ${decision.snapshot.rules.length} 条规则，审批链 ${decision.steps.length} 步` });
  return { approval, deduplicated: false };
}

/** 驳回后重提：按最新规则重新路由（规则可能已调整），revision 递增，历史快照被替换。 */
export function resubmitApproval(id: string) {
  const item = approvals.find(approval => approval.id === id);
  if (!item || item.status !== 'rejected') return undefined;
  const decision = routeApproval(routingRules, buildRoutingContext(item));
  item.steps = decision.steps.map(step => ({ ...step, status: 'pending' as const }));
  item.currentStepIndex = 0;
  item.status = 'pending';
  item.revision += 1;
  item.routing = decision.snapshot;
  item.approver = item.steps[0].approver;
  item.comment = undefined;
  auditEvents.unshift({ id: nextAuditId(), action: 'RESUBMIT', entity: item.entityType, entityId: item.entityId, actor: item.requestedBy, at: new Date().toISOString(), details: `${item.title} 第 ${item.revision} 次提交，按最新规则重新路由为 ${item.steps.length} 步审批链` });
  return item;
}

export function dashboard() { return projects.map(project => projectSummary(project.id)).map(summary => ({ id: summary.project?.id, title: summary.project?.title, status: summary.project?.status, forecast: summary.forecast, variance: summary.variance, pendingApprovals: summary.pendingApprovals, rightsConflicts: rightsConflicts(summary.project?.id).length })); }
