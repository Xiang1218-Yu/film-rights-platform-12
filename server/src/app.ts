import express, { type NextFunction, type Request, type Response } from 'express';
import {
  approvals, assets, auditEvents, budgetLines, contracts, currentStep, dashboard,
  projectSummary, projects, resolveFacts,
} from './domain.js';
import {
  actOnStep, createApproval, getConfig, HttpError, migrateLegacyApprovals, previewRoute,
  rightsRiskView, updateConfig, writeLock, ConfigValidationError,
} from './store.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  // 旧版静态 approver 数据补算规则链；幂等，重复启动/重建 app 不会重复迁移
  const migration = migrateLegacyApprovals();
  if (migration.migrated.length) console.log(`审批路由迁移完成：${migration.migrated.length} 单旧审批已补算规则链`);

  app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
  app.get('/api/projects', (_req, res) => res.json(projects));
  app.get('/api/projects/:id/summary', (req, res, next) => {
    const result = projectSummary(req.params.id);
    if (!result.project) return next(new HttpError(404, 'PROJECT_NOT_FOUND', '项目不存在'));
    res.json(result);
  });
  app.get('/api/projects/:id/rights-conflicts', (req, res, next) => {
    if (!projects.some(project => project.id === req.params.id))
      return next(new HttpError(404, 'PROJECT_NOT_FOUND', '项目不存在'));
    res.json(rightsRiskView(req.params.id));
  });
  app.get('/api/projects/:id/assets', (req, res) => res.json(assets.filter(asset => asset.projectId === req.params.id)));
  app.get('/api/projects/:id/contracts', (req, res) => res.json(contracts.filter(contract => contract.projectId === req.params.id)));
  app.get('/api/budgets/:projectId/lines', (req, res) => res.json(budgetLines.filter(line => line.projectId === req.params.projectId)));

  // 当前生效的路由规则（控制台解释分派原因用）
  app.get('/api/routing/rules', (_req, res) => res.json(getConfig()));
  // 不落地的路由试算：同一套事实解析与规则引擎
  app.post('/api/routing/preview', (req, res, next) => {
    try {
      const { projectId, entityType, entityId, requestedBy, overrides } = req.body ?? {};
      if (typeof projectId !== 'string' || typeof entityId !== 'string'
        || !['budget', 'asset', 'delivery'].includes(entityType))
        throw new HttpError(400, 'VALIDATION_ERROR', '需要 projectId、entityType(budget/asset/delivery) 与 entityId');
      const facts = resolveFacts({ projectId, entityType, entityId, overrides });
      res.json(previewRoute(facts, typeof requestedBy === 'string' ? requestedBy : ''));
    } catch (error) { next(error); }
  });
  // 热更新规则：校验失败拒绝并保留旧配置
  app.put('/api/routing/rules', async (req, res, next) => {
    try {
      const actor = typeof req.body?.updatedBy === 'string' ? req.body.updatedBy : '当前管理员';
      const nextConfig = await writeLock.runExclusive(() => updateConfig(actor, req.body?.rules));
      res.json(nextConfig);
    } catch (error) { next(error); }
  });

  app.get('/api/approvals', (req, res) => {
    const { projectId, approver, status } = req.query;
    let list = approvals;
    if (typeof projectId === 'string') list = list.filter(item => item.projectId === projectId);
    if (typeof status === 'string') list = list.filter(item => item.status === status);
    if (typeof approver === 'string')
      list = list.filter(item => (item.status === 'pending' ? currentStep(item)?.approver : item.approver) === approver);
    res.json(list);
  });

  app.post('/api/approvals', async (req, res, next) => {
    try {
      const result = await writeLock.runExclusive(() => createApproval(req.body ?? {}));
      res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (error) { next(error); }
  });
  app.patch('/api/approvals/:id', async (req, res, next) => {
    try {
      const actor = typeof req.body?.actor === 'string' && req.body.actor.trim() ? req.body.actor.trim() : '当前审批人';
      const status = req.body?.status;
      if (status !== 'approved' && status !== 'rejected')
        throw new HttpError(400, 'VALIDATION_ERROR', 'status 必须是 approved 或 rejected');
      const comment = typeof req.body?.comment === 'string' ? req.body.comment : '';
      const result = await writeLock.runExclusive(() => actOnStep(req.params.id, actor, status, comment));
      res.json(result);
    } catch (error) { next(error); }
  });

  app.get('/api/audit', (req, res) => {
    const { entity, entityId, limit } = req.query;
    let list = auditEvents;
    if (entity) list = list.filter(event => event.entity === entity);
    if (entityId) list = list.filter(event => event.entityId === entityId);
    const max = Math.min(Number(limit) || 100, 500);
    res.json(list.slice(0, max));
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'film-rights-platform' }));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError)
      return res.status(error.status).json({ message: error.message, code: error.code, ...error.extra });
    if (error instanceof ConfigValidationError)
      return res.status(400).json({ message: error.message, code: 'INVALID_ROUTING_CONFIG', errors: error.errors });
    if (error instanceof SyntaxError)
      return res.status(400).json({ message: '请求体不是合法 JSON', code: 'BAD_JSON' });
    console.error(error);
    res.status(500).json({ message: '服务内部错误', code: 'INTERNAL' });
  });

  return app;
}

export function startServer(port = Number(process.env.PORT || 4104)) {
  const app = createApp();
  return app.listen(port, () => console.log(`film rights API listening on ${port}`));
}
