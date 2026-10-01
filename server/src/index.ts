import express from 'express';
import { approve, assets, budgetLines, contracts, createApproval, dashboard, projectSummary, projects, resubmitApproval, rightsConflicts, routingConfigIssues, routingRules } from './domain.js';
const app = express(); app.use(express.json());
app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/projects', (_req, res) => res.json(projects));
app.get('/api/projects/:id/summary', (req, res) => { const result = projectSummary(req.params.id); if (!result.project) return res.status(404).json({ message: '项目不存在' }); res.json(result); });
app.get('/api/projects/:id/rights-conflicts', (req, res) => res.json(rightsConflicts(req.params.id)));
app.get('/api/projects/:id/assets', (req, res) => res.json(assets.filter(asset => asset.projectId === req.params.id)));
app.get('/api/projects/:id/contracts', (req, res) => res.json(contracts.filter(contract => contract.projectId === req.params.id)));
app.get('/api/budgets/:projectId/lines', (req, res) => res.json(budgetLines.filter(line => line.projectId === req.params.projectId)));
app.get('/api/routing/rules', (_req, res) => res.json({ rules: routingRules, issues: routingConfigIssues }));
app.post('/api/approvals', (req, res) => {
  const { projectId, entityType, entityId, title, requestedBy } = req.body ?? {};
  if (!projectId || !entityType || !entityId || !title || !requestedBy) return res.status(400).json({ message: '缺少必填字段：projectId/entityType/entityId/title/requestedBy' });
  if (!['budget', 'asset', 'delivery'].includes(entityType)) return res.status(400).json({ message: 'entityType 必须是 budget/asset/delivery' });
  const { approval, deduplicated } = createApproval(req.body);
  res.status(deduplicated ? 200 : 201).json({ ...approval, deduplicated });
});
app.post('/api/approvals/:id/resubmit', (req, res) => { const result = resubmitApproval(req.params.id); if (!result) return res.status(409).json({ message: '审批不存在或不处于已驳回状态' }); res.json(result); });
app.patch('/api/approvals/:id', (req, res) => {
  const { status, comment, actor } = req.body ?? {};
  if (status !== 'approved' && status !== 'rejected') return res.status(400).json({ message: 'status 必须是 approved 或 rejected' });
  const result = approve(req.params.id, status, comment, actor);
  if (!result) return res.status(404).json({ message: '审批不存在' });
  res.json(result);
});
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'film-rights-platform' }));
const port = Number(process.env.PORT || 4104); app.listen(port, () => console.log(`film rights API listening on ${port}`));
