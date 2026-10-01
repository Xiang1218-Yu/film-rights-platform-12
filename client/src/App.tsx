import { useCallback, useEffect, useMemo, useState } from 'react';

type StepStatus = 'pending' | 'waiting' | 'approved' | 'rejected' | 'skipped';
type Project = { id: string; title: string; status: string; deliveryDate: string };
type Step = { id: string; order: number; ruleId: string; ruleName: string; reason: string; approver: string; selfApproved: boolean; escalated: boolean; status: StepStatus; actor?: string; comment?: string; decidedAt?: string };
type MatchedRule = { ruleId: string; ruleName: string; priority: number; reason: string; approver: string; resolvedApprover: string; selfApproved: boolean; escalated: boolean; merged?: boolean; mergedIntoRuleId?: string };
type Snapshot = { configVersion: number; decidedAt: string; legacy?: boolean; fallbackUsed?: boolean; warnings: string[]; rules: MatchedRule[]; chain: { order: number; approver: string; ruleId: string; ruleName: string; reason: string }[] };
type Approval = { id: string; title: string; status: 'pending' | 'approved' | 'rejected'; approver: string; requestedBy: string; entityType: string; entityId: string; attempt: number; replacedFromId?: string; comment?: string; createdAt: string; steps: Step[]; routing: Snapshot };
type PendingStep = { approvalId: string; title: string; entityType: string; approver: string; ruleId: string; ruleName: string; reason: string; order: number; total: number };
type Summary = {
  planned: number; forecast: number; actual: number; variance: number; utilization: number; committed: number;
  contractExposure: number; assetCount: number; pendingApprovals: number; pendingSteps: PendingStep[]; pendingStepsByApprover: Record<string, number>;
  highRiskLines: { subcategory: string; forecast: number; planned: number }[];
  lines: { id: string; category: string; subcategory: string; planned: number; forecast: number; actual: number; risk: string }[];
  contracts: { vendor: string; scope: string; committed: number; paid: number; milestones: { name: string; due: string; status: string }[] }[];
  assets: { id: string; name: string; type: string; version: number; status: string; availableTo: string }[];
  approvals: Approval[]; project: Project;
};
type LockPreview = { requestedBy: string; fallbackUsed: boolean; chain: { order: number; approver: string; ruleId: string; ruleName: string; reason: string }[] };
type Conflict = { severity: string; assetA: string; assetB: string; reason: string; previewLockRouteA?: LockPreview; previewLockRouteB?: LockPreview };
type RoutingRuleDef = { id: string; name: string; enabled: boolean; priority: number; approver: string; fallbackApprover?: string; reasonTemplate: string; stopOnMatch?: boolean };
type RoutingConfig = { version: number; updatedAt: string; updatedBy?: string; defaultFallbackApprover: string; rules: RoutingRuleDef[] };
type AuditRow = { id: string; action: string; entity: string; entityId: string; actor: string; at: string; details: string };

const money = (n: number) => `¥${(n / 10000).toFixed(0)}万`;
const api = '/api';
const entityLabel: Record<string, string> = { budget: '预算', asset: '资产', delivery: '交付' };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败 (${response.status})`);
  return body as T;
}

const statusClass: Record<string, string> = { pending: 'pending', waiting: 'waiting', approved: 'approved', rejected: 'rejected', skipped: 'skipped' };
const statusLabel: Record<string, string> = { pending: '当前节点', waiting: '等待中', approved: '已通过', rejected: '已驳回', skipped: '已跳过' };

function ChainTimeline({ steps, compact }: { steps: Step[]; compact?: boolean }) {
  return <div className={`chain ${compact ? 'compact' : ''}`}>{steps.map(step => (
    <div className={`chain-step ${step.status}`} key={step.id}>
      <span className={`step-dot ${statusClass[step.status]}`} title={statusLabel[step.status]} />
      <div>
        <b>{step.order}. {step.approver}</b>
        <small>{step.ruleName} · {step.ruleId}{step.selfApproved ? <em className="escalation"> 申请人回避→已升级</em> : null}</small>
        {!compact && <small className="reason">{step.reason}</small>}
        {step.comment && <small className="step-comment">「{step.comment}」— {step.actor}</small>}
      </div>
      <span className={`step-state ${step.status}`}>{statusLabel[step.status]}</span>
    </div>
  ))}</div>;
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('PRJ-001');
  const [summary, setSummary] = useState<Summary>();
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [rulesConfig, setRulesConfig] = useState<RoutingConfig>();
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [tab, setTab] = useState<'overview' | 'budget' | 'rights' | 'approvals'>('overview');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [identity, setIdentity] = useState('财务负责人');

  const load = useCallback(async (id = 'PRJ-001') => {
    setLoading(true); setError('');
    try {
      const items = await request<Project[]>('/projects');
      const active = items.find(item => item.id === id) ?? items[0];
      if (!active) throw new Error('服务端没有返回项目数据');
      const [s, c, cfg, auditRows] = await Promise.all([
        request<Summary>(`/projects/${active.id}/summary`),
        request<{ conflicts: Conflict[] }>(`/projects/${active.id}/rights-conflicts`),
        request<RoutingConfig>('/routing/rules'),
        request<AuditRow[]>('/audit?limit=30'),
      ]);
      setProjects(items); setSelected(active.id); setSummary(s);
      setConflicts(c.conflicts); setRulesConfig(cfg); setAudit(auditRows);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法连接制作服务');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refresh = useCallback(() => load(selected), [load, selected]);

  const identities = useMemo(() => {
    const names = new Set<string>(['财务负责人', '总制片人', '法务负责人', '后期总监', '风险委员会', '制片主任', '后期制片', '视觉总监']);
    Object.keys(summary?.pendingStepsByApprover ?? {}).forEach(name => names.add(name));
    return [...names];
  }, [summary]);

  const myTodo = useMemo(
    () => (summary?.pendingSteps ?? []).filter(step => step.approver === identity),
    [summary, identity],
  );

  const act = async (id: string, status: 'approved' | 'rejected') => {
    try {
      const result = await request<{ approval: Approval; finished: boolean }>(`/approvals/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: identity, status, comment: status === 'approved' ? '在控制台完成复核' : '在控制台驳回' }),
      });
      setMessage(result.finished ? `审批链已结束：${result.approval.status === 'approved' ? '全部通过' : '已驳回，可修改后重提'}` : '已通过当前节点，流转到下一审批人');
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '审批操作失败'); }
  };

  const variancePct = summary ? Math.round(summary.variance / summary.planned * 100) : 0;

  if (loading && !summary) return <main className="connection-state"><div className="loading">正在载入制作控制台…</div><small>正在通过 Vite API 代理连接本地制作服务</small></main>;
  if (!summary) return <main className="connection-state"><h2>无法连接制作服务</h2><p>{error || '服务端没有返回项目数据。'}</p><p>请从项目根目录运行 <code>npm run dev</code>，确认前端 5173 和 API 4104 均已启动。</p><button onClick={() => void load(selected)}>重新连接</button></main>;

  return <main>
    <header>
      <div>
        <div className="eyebrow">STUDIO OPS / RULE-BASED APPROVAL ROUTING</div>
        <h1>FrameLedger <span>规则路由审批 · 预算 / 母版 / 海外版权</span></h1>
        <p>按项目、实体类型、金额偏差、资产状态与版权风险生成审批链；命中规则快照随申请保存，待办、审计与风险视图共用同一决定。</p>
      </div>
      <div className="header-actions">
        <label className="identity"><small>当前操作身份</small><select value={identity} onChange={e => setIdentity(e.target.value)}>{identities.map(name => <option key={name} value={name}>{name}{summary.pendingStepsByApprover[name] ? `（${summary.pendingStepsByApprover[name]} 待办）` : ''}</option>)}</select></label>
        <select value={selected} onChange={e => { setSelected(e.target.value); void load(e.target.value); }}>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
        <span className="live"><i /> LIVE CONTROL</span>
      </div>
    </header>
    {message && <div className="toast" onClick={() => setMessage('')}>{message} ×</div>}
    {error && <div className="toast error-toast" onClick={() => setError('')}>{error} ×</div>}

    <section className="kpis">
      <div><small>FORECAST COST</small><b>{money(summary.forecast)}</b><span>预算偏差 <em className={summary.variance > 0 ? 'bad' : ''}>{variancePct}%</em></span></div>
      <div><small>COMMITTED</small><b>{money(summary.committed)}</b><span>已锁定供应商与合同</span></div>
      <div><small>ASSET REGISTER</small><b>{summary.assetCount}<em> 个</em></b><span>版本与交付状态纳管</span></div>
      <div><small>RISK QUEUE</small><b>{summary.pendingSteps.length + conflicts.length}<em> 项</em></b><span>{conflicts.length} 条版权冲突 / {summary.pendingSteps.length} 个链上待办节点</span></div>
    </section>

    <nav className="tabs">
      <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>项目驾驶舱</button>
      <button className={tab === 'budget' ? 'active' : ''} onClick={() => setTab('budget')}>预算与合同</button>
      <button className={tab === 'rights' ? 'active' : ''} onClick={() => setTab('rights')}>资产版权图谱</button>
      <button className={tab === 'approvals' ? 'active' : ''} onClick={() => setTab('approvals')}>审批路由中心 {myTodo.length > 0 && <span className="tab-badge">{myTodo.length}</span>}</button>
      <span>交付日 {summary.project.deliveryDate}</span>
    </nav>

    {tab === 'overview' && <div className="grid">
      <section className="panel hero">
        <div className="panel-head"><div><div className="eyebrow">PROJECT HEALTH / {summary.project.id}</div><h2>{summary.project.title}</h2></div><span className="badge amber">{summary.project.status.toUpperCase()}</span></div>
        <div className="progress-label"><span>成本消耗 {Math.round(summary.utilization * 100)}%</span><b>{money(summary.actual)} / {money(summary.planned)}</b></div>
        <div className="progress"><i style={{ width: `${Math.min(100, summary.utilization * 100)}%` }} /></div>
        <div className="split"><div><small>合同暴露额</small><strong>{money(summary.contractExposure)}</strong></div><div><small>高风险预算项</small><strong className="bad">{summary.highRiskLines.length}</strong></div><div><small>版权冲突</small><strong className={conflicts.length ? 'bad' : ''}>{conflicts.length}</strong></div></div>
      </section>
      <section className="panel">
        <div className="panel-head"><h3>我的待办节点 · {identity}</h3><span>{myTodo.length} TODO</span></div>
        {myTodo.length ? myTodo.map(step => (
          <div className="approval" key={`${step.approvalId}-${step.order}`}>
            <span className="status pending" />
            <div><b>{step.title}</b><small>{entityLabel[step.entityType]} · 节点 {step.order}/{step.total} · {step.ruleName}</small><small className="reason">{step.reason}</small></div>
            <button onClick={() => act(step.approvalId, 'approved')}>通过</button>
          </div>
        )) : <div className="empty">当前身份没有待办节点，可切换身份体验不同审批人视角。</div>}
      </section>
      <section className="panel wide">
        <div className="panel-head"><h3>交付风险雷达</h3><span>基于版本、授权窗口、预算预测与规则链预览</span></div>
        {conflicts.length ? conflicts.map((c, i) => (
          <div className="risk-row" key={i}>
            <strong className={c.severity}>{c.severity === 'critical' ? 'CRITICAL' : 'WARNING'}</strong>
            <div><b>{c.assetA}</b><small>↔ {c.assetB} · {c.reason}</small>
              {(c.previewLockRouteA || c.previewLockRouteB) && <small className="reason">若发起锁定，审批链：{(c.previewLockRouteA ?? c.previewLockRouteB)!.chain.map(node => `${node.order}.${node.approver}`).join(' → ')}</small>}
            </div>
          </div>
        )) : <div className="empty">当前项目未发现版权窗口冲突。</div>}
      </section>
    </div>}

    {tab === 'budget' && <div className="grid">
      <section className="panel wide">
        <div className="panel-head"><h3>预算版本 / 成本基线</h3><span>实际 + 承诺 + 预测；预算审批按偏差与金额路由财务</span></div>
        <div className="table"><div className="tr th"><span>科目</span><span>预算</span><span>已承诺</span><span>实际</span><span>预测</span><span>风险</span></div>{summary.lines.map(line => <div className="tr" key={line.id}><span><b>{line.category}</b><small>{line.subcategory}</small></span><span>{money(line.planned)}</span><span>{money(line.planned ? line.planned : 0)}</span><span>{money(line.actual)}</span><span className={line.forecast > line.planned ? 'bad' : ''}>{money(line.forecast)}</span><span className={`risk ${line.risk}`}>{line.risk}</span></div>)}</div>
      </section>
      <section className="panel"><div className="panel-head"><h3>供应商付款里程碑</h3></div>{summary.contracts.map(c => <div className="contract" key={c.vendor}><b>{c.vendor}</b><small>{c.scope}</small><div className="contract-bar"><i style={{ width: `${Math.round(c.paid / c.committed * 100)}%` }} /></div><span>{money(c.paid)} / {money(c.committed)}</span><em>{c.milestones.filter(m => m.status !== 'paid').length} 个待结点</em></div>)}</section>
    </div>}

    {tab === 'rights' && <div className="grid">
      <section className="panel wide">
        <div className="panel-head"><h3>资产版本登记</h3><span>{summary.assets.length} assets / checksum tracked</span></div>
        <div className="table"><div className="tr th"><span>资产</span><span>版本</span><span>状态</span><span>授权截止</span></div>{summary.assets.map(a => <div className="tr" key={a.id}><span><b>{a.name}</b><small>{a.id} · {a.type}</small></span><span>v{a.version}</span><span className={`pill ${a.status}`}>{a.status}</span><span>{a.availableTo}</span></div>)}</div>
      </section>
      <section className="panel">
        <div className="panel-head"><h3>授权冲突 + 锁定审批链预览</h3><span>{conflicts.length} detected · 与申请同引擎</span></div>
        {conflicts.map((c, i) => <div className="conflict" key={i}>
          <strong>{c.severity}</strong><b>{c.assetA} ↔ {c.assetB}</b><small>{c.reason}</small>
          {c.previewLockRouteA && <div className="preview-chain"><small>申请人 {c.previewLockRouteA.requestedBy} 发起锁定将路由到：</small>{c.previewLockRouteA.chain.map(node => <small key={node.order} className="reason">节点{node.order} · {node.approver}（{node.ruleName}）</small>)}</div>}
        </div>)}
      </section>
    </div>}

    {tab === 'approvals' && <ApprovalsTab summary={summary} rulesConfig={rulesConfig} audit={audit} identity={identity} selected={selected} onChanged={refresh} onError={setError} onAct={act} />}

    <footer>FrameLedger 规则路由 · 命中规则快照随申请持久化 · 待办计数 / 审计 / 风险视图共用 routing engine · 内存仓储 + REST API</footer>
  </main>;
}

function ApprovalsTab({ summary, rulesConfig, audit, identity, selected, onChanged, onError, onAct }: {
  summary: Summary; rulesConfig?: RoutingConfig; audit: AuditRow[]; identity: string; selected: string;
  onChanged: () => Promise<void>; onError: (msg: string) => void;
  onAct: (id: string, status: 'approved' | 'rejected') => Promise<void>;
}) {
  const [form, setForm] = useState({ entityType: 'asset' as 'budget' | 'asset' | 'delivery', entityId: 'AST-001', title: '', requestedBy: identity, amount: '', territories: 'US', rightsTags: '', assetStatus: 'locked' });
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(f => ({ ...f, requestedBy: identity })), [identity]);

  const submit = async () => {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        projectId: selected, entityType: form.entityType, entityId: form.entityId.trim(),
        title: form.title.trim() || `${form.entityId} 审批申请`, requestedBy: form.requestedBy.trim(),
        idempotencyKey: `${selected}-${form.entityType}-${form.entityId}-${Date.now()}`,
      };
      if (form.entityType === 'asset' || form.entityType === 'delivery') {
        payload.assetStatus = form.assetStatus;
        payload.territories = form.territories.split(/[,，\s]+/).filter(Boolean);
        payload.rightsTags = form.rightsTags.split(/[,，\s]+/).filter(Boolean);
      }
      if (form.entityType === 'budget' && form.amount.trim()) payload.amount = Number(form.amount);
      const result = await request<{ approval: Approval; resubmitted: boolean; idempotentReplay: boolean }>('/approvals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const chainText = result.approval.routing.chain.map(node => `${node.order}.${node.approver}`).join(' → ');
      onError('');
      alert(result.resubmitted ? `驳回重提成功（第 ${result.approval.attempt} 次），审批链：${chainText}` : `已创建，审批链：${chainText}`);
      setForm(f => ({ ...f, title: '' }));
      await onChanged();
    } catch (reason) { onError(reason instanceof Error ? reason.message : '创建失败'); }
    finally { setBusy(false); }
  };

  return <div className="grid approvals-grid">
    <section className="panel wide">
      <div className="panel-head"><h3>发起审批（实时规则路由）</h3><span>重复触发自动拦截；被拒后再次提交记为重提</span></div>
      <div className="new-form">
        <label>实体类型<select value={form.entityType} onChange={e => setForm(f => ({ ...f, entityType: e.target.value as typeof f.entityType }))}><option value="budget">预算 budget</option><option value="asset">资产 asset</option><option value="delivery">交付 delivery</option></select></label>
        <label>实体 ID<input value={form.entityId} onChange={e => setForm(f => ({ ...f, entityId: e.target.value }))} placeholder="如 AST-001 / DEL-009" /></label>
        <label>标题<input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="审批标题" /></label>
        <label>申请人<input value={form.requestedBy} onChange={e => setForm(f => ({ ...f, requestedBy: e.target.value }))} /></label>
        {form.entityType !== 'budget' && <>
          <label>{form.entityType === 'asset' ? '资产目标状态' : '交付状态'}<select value={form.assetStatus} onChange={e => setForm(f => ({ ...f, assetStatus: e.target.value }))}><option value="review">review</option><option value="approved">approved</option><option value="locked">locked</option></select></label>
          <label>地域（逗号分隔）<input value={form.territories} onChange={e => setForm(f => ({ ...f, territories: e.target.value }))} placeholder="CN, US, 全球" /></label>
          <label>版权标签<input value={form.rightsTags} onChange={e => setForm(f => ({ ...f, rightsTags: e.target.value }))} placeholder="音乐-同步许可" /></label>
        </>}
        {form.entityType === 'budget' && <label>覆盖金额（可选）<input value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="留空用预算预测" /></label>}
        <button className="primary" disabled={busy || !form.entityId.trim() || !form.requestedBy.trim()} onClick={() => void submit()}>{busy ? '提交中…' : '生成审批链'}</button>
      </div>
    </section>

    <section className="panel wide">
      <div className="panel-head"><h3>审批队列与规则快照</h3><span>{summary.approvals.length} 单 · 只有当前节点审批人可操作</span></div>
      {summary.approvals.map(a => {
        const step = a.steps.find(s => s.status === 'pending');
        const mine = a.status === 'pending' && step?.approver === identity;
        return <div className={`approval-card ${a.status}`} key={a.id}>
          <div className="approval-card-head">
            <span className={`status ${a.status}`} />
            <b>{a.title}</b>
            <span className="pill light">{entityLabel[a.entityType]} · {a.entityId}</span>
            <span className="pill light">第 {a.attempt} 次{a.replacedFromId ? `（承接 ${a.replacedFromId}）` : ''}</span>
            {a.routing.legacy && <span className="pill legacy">旧数据迁移 · 配置 v{a.routing.configVersion}</span>}
            {!a.routing.legacy && <span className="pill light">配置 v{a.routing.configVersion}</span>}
            {a.routing.fallbackUsed && <span className="pill warn">兜底审批</span>}
            <span className={`pill ${a.status}`}>{a.status}</span>
            {mine && <span className="pill mine">轮到我（{identity}）</span>}
          </div>
          <div className="approval-meta">
            <small>申请人 {a.requestedBy} · {a.createdAt.slice(0, 10)} · {a.id}</small>
            {a.status === 'pending' && <small>当前节点审批人：<b>{a.approver}</b></small>}
          </div>
          <ChainTimeline steps={a.steps} />
          <details>
            <summary>命中规则快照（{a.routing.rules.length} 条）与分派原因</summary>
            <div className="snapshot">
              {a.routing.rules.map(rule => <div key={rule.ruleId} className={`snap-rule ${rule.merged ? 'merged' : ''}`}>
                <small><b>P{rule.priority}</b> · {rule.ruleId} · {rule.ruleName}{rule.merged ? ` · 合并入 ${rule.mergedIntoRuleId}` : ''}{rule.selfApproved ? ' · 申请人回避已升级' : ''}</small>
                <small className="reason">{rule.reason}</small>
              </div>)}
              {a.routing.warnings.map((w, i) => <small key={i} className="bad">⚠ {w}</small>)}
            </div>
          </details>
          {a.status === 'pending' && <div className="card-actions">
            {mine ? <>
              <button className="primary" onClick={() => void onAct(a.id, 'approved')}>通过（以 {identity} 身份）</button>
              <button className="danger" onClick={() => void onAct(a.id, 'rejected')}>驳回</button>
            </> : <em>等待 {a.approver} 处理（切换到该身份可操作）</em>}
          </div>}
          {a.status !== 'pending' && a.comment && <small className="step-comment">结论意见：{a.comment}</small>}
        </div>;
      })}
    </section>

    <section className="panel">
      <div className="panel-head"><h3>生效路由规则</h3><span>v{rulesConfig?.version} · {rulesConfig?.rules.length} 条</span></div>
      <div className="rules-list">{(rulesConfig?.rules ?? []).filter(r => r.enabled).sort((x, y) => x.priority - y.priority).map(rule => <div key={rule.id} className="rule-def">
        <small><b>P{rule.priority}</b> · {rule.id}{rule.stopOnMatch ? ' · 命中即止' : ''}</small>
        <b>{rule.name} → {rule.approver}</b>
        {rule.fallbackApprover && <small>申请人回避时升级：{rule.fallbackApprover}</small>}
        <small className="reason">{rule.reasonTemplate}</small>
      </div>)}</div>
      <small className="reason">兜底审批人：{rulesConfig?.defaultFallbackApprover}</small>
    </section>

    <section className="panel">
      <div className="panel-head"><h3>审计流</h3><span>节点动作 + 创建 / 驳回 / 重提 / 配置变更 / 迁移</span></div>
      {audit.slice(0, 18).map(row => <div className="audit-row" key={row.id}><strong className={`audit-action ${row.action.toLowerCase()}`}>{row.action}</strong><div><small>{row.actor} · {row.entity}/{row.entityId}</small><small className="reason">{row.details}</small><small>{new Date(row.at).toLocaleString('zh-CN')}</small></div></div>)}
    </section>
  </div>;
}
