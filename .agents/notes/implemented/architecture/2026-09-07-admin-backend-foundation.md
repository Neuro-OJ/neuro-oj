# Agent Note: Admin 后端基础（admin 域骨架 + 统一审计 + 乐观锁）

Status: implemented

## Problem

管理端路由原先分散在 `src/routes/admin/` 与各业务域中，缺少统一入口、统一审计封装和写操作的乐观锁基础。实施 Admin UI 重做前，需要先建立 `domains/admin` 门面域，为后续 sub domain 迁移和前端并发编辑提供地基。

## Decision

在 noj-core 新增 `domains/admin` 域，并落地三项基础能力：

- **admin 域骨架**：新建 `src/domains/admin/index.ts` 作为管理端路由组合 barrel，承接原有各域 admin router；`app.ts` 改为从 `domains/admin` 导入并仍挂载 `/api/v1/admin`。
- **统一审计封装**：`services/admin-audit.ts` 提供 `registerAudit`/`getAuditMeta`/`adminAudit`/`withAudit`。审计元数据注册表支持 `:param` 路径模式匹配；`withAudit` 只在 2xx 成功响应后执行审计，且整个审计后处理块 try/catch，失败仅记录日志、绝不把已成功的业务响应变成 5xx。
- **乐观锁基础**：`services/admin-version.ts` 提供 `VersionConflictError`/`assertVersion`，`middleware/admin-version.ts` 提供 `readVersion`/`adminVersionMiddleware`，通过 `If-Match` 头传递期望版本。

同时将 `If-Match` 加入 CORS `allowHeaders`，保证管理后台跨域预检可用。

## Alternatives considered

- 不建统一 admin 域，继续在 `routes/admin/` 堆积：无法收敛跨域引用，后续迁移子域时仍要重复改挂载点。
- 审计注册表只做精确匹配：真实请求路径含 `:id` 参数时无法命中，必须要求调用方额外传 `routePath`；与“按真实请求路径即可取 metadata”的目标不符，因此选择简单 `:param` 模式匹配。
- 审计后处理失败直接向上抛：会破坏已成功的业务响应，违背审计“辅助能力”的定位；因此选择 try/catch + 日志记录。
- 乐观锁先做完整 HTTP 语义（`If-Match: *`、弱校验器、404/409 细分）：当前路由迁移尚未开始，过早实现会增加未经验证的契约面；本次仅固定基础约定并留待路由迁移补齐。

## Consequences

- 后续 admin 子域迁移应通过 `domains/admin` 门面组合，并复用 `withAudit`/`adminVersionMiddleware`。
- `getAuditMeta` 支持 `:param` 模式匹配，调用方可直接传真实请求路径。
- `adminAudit` 不再接收 `Context` 参数；`assertVersion` 以 `services/admin-version.ts` 为唯一公开出口，middleware 不再重复导出。
- `VersionConflictError` 当前响应体只含 `current`（token），不含 spec 中的完整 `current` 资源形状；该差异已记录，待路由迁移阶段补齐。
- CORS 白名单新增 `If-Match`，前端跨域携带版本头不再被预检拦截。
