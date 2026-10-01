# FrameLedger · 影视制作预算与资产版权协同平台

React + Vite + TypeScript 前端，Node.js + Express + TypeScript 服务端。面向中型影视制作团队，演示预算版本、成本预测、合同里程碑、资产版本、授权窗口冲突与审批审计的协同闭环。

## 启动

```bash
npm install
npm run dev
```

前端默认 Vite 端口 5173，API 默认 `http://localhost:4104`（Vite 已配置 `/api` 代理）。

## 业务能力

- 项目 / 季 / 交付日期与预算基线；计划、承诺、实际、预测成本四账合一
- 供应商合同额度、付款里程碑与付款暴露额
- 母版、预告、海报、音频、字幕等资产版本和 checksum 登记
- 地域、平台、有效期、版权标签冲突检测
- **可配置规则路由审批**：按项目、实体类型、金额/偏差、资产状态、境外与版权风险生成串行审批链
- 预算 / 资产 / 交付审批队列、节点级待办计数与审计事件
- React 控制台支持项目切换、预算表、风险雷达（含审批链预览）、身份切换、发起/审批/驳回重提、规则与审计视图

## 审批规则路由

单一静态 approver 已替换为纯函数规则引擎（`server/src/routing.ts`），API、待办计数、审计与风险视图共用同一份决定：

- **规则条件**：`projectIds / entityTypes / assetTypes / assetStatuses / minAmount|maxAmount / minVariancePct|maxVariancePct / minRisk / overseasOnly / rightsRisk`；`priority` 升序决定先后，`stopOnMatch` 可截断后续规则。
- **审批链**：全部命中规则按优先级排序，同一审批人的多条规则合并为一个节点（快照中标记 `merged`），未命中任何规则时走兜底审批人，链永不空。
- **申请人回避**：审批人等于申请人时，按 `规则 fallbackApprover → 配置默认升级人 → 平台值班管理员` 逐级升级，杜绝自评。
- **规则快照**：申请创建时把命中规则、解释原因、配置版本固化在 `approval.routing` 上；规则后续热更新不会改写历史申请。
- **重复触发**：同一实体有进行中申请时返回 `409 DUPLICATE_ACTIVE_REQUEST`；携带相同 `idempotencyKey` 的重放返回 `200` 原单。写操作经进程内互斥串行化，并发创建只成一单。
- **驳回重提**：任一节点驳回即终止（后续节点 `skipped`）；同实体再次提交得到 `attempt + 1` 的新单并记录 `replacedFromId` 与 `RESUBMIT` 审计。
- **空/坏配置**：空规则集合法（全部走兜底）；结构性坏配置在 `PUT /api/routing/rules` 时整体拒绝（400 + 全部字段错误）并保留旧版本；运行时单条坏规则只告警跳过，不阻断申请。
- **旧数据迁移**：启动时为只有静态 `approver` 的旧申请补算规则链（`routing.legacy=true`），尽量保留旧办理位置（其之前的节点标 `skipped`），迁移幂等。
- **境外判定**：地域中包含 `CN/中国大陆/内地` 以外的任何值（含 `全球`、`HK`、`US` 等）即视为境外。

### HTTP API（摘要）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dashboard` | 项目总览，含链上待办数与按审批人聚合 |
| GET | `/api/projects/:id/summary` | 项目视图：`pendingSteps` / `pendingStepsByApprover` 与完整申请 |
| GET | `/api/projects/:id/rights-conflicts` | 冲突 + 冲突资产「若申请锁定」的审批链预览 |
| POST | `/api/routing/preview` | 不落地的路由试算（同一事实解析与引擎） |
| GET/PUT | `/api/routing/rules` | 查看生效规则 / 热更新（校验失败保留旧版） |
| POST | `/api/approvals` | 创建（幂等键重放 200、重复 409、驳回重提 201） |
| PATCH | `/api/approvals/:id` | 当前节点 `approved`/`rejected`（body 带 `actor`，越权 403） |
| GET | `/api/approvals?projectId&approver&status` | 队列查询（待办按当前节点审批人过滤） |
| GET | `/api/audit?entity&entityId&limit` | 审计流（创建/节点通过/驳回/重提/配置更新/迁移） |

当前使用内存数据，领域服务按模块设计（`routing` 纯引擎、`domain` 事实与视图、`store` 生命周期/迁移），后续可替换 PostgreSQL、对象存储、工作流和版权方台账服务。

