# Agent Note: legal、tags、checkin 迁入功能切片（阶段 4 首批）

Status: implemented

## Problem

core 重构阶段 4 采用「改到即迁」，首批主动迁移体量小、耦合低的功能，验证
trainings 样例可复制，并暴露迁移中的共性陷阱。

## Decision

- legal（文档、同意、数据请求、管理端）、tags（标签）、checkin（签到）分别迁入
  `src/features/<name>/`，登记到
  `src/features.ts`；旧挂载、合同转出文件、`application`
  中的纯转发命令与模块出口中的迁走导出一并删除。
- 迁出的 admin 路由不再经过 `/api/v1/admin` 聚合中间件：legal 在功能路由内对
  `/admin/legal/*` 显式挂 `authMiddleware`，并从 `FINE_GRAINED_ADMIN_PREFIXES`
  删除该前缀；补「未登录 401」测试。
- 旧模块能力经模块出口提供：`platform/index.ts` 新增
  `enforceRateLimit`、`getClientIp`；`access/index.ts` 新增
  `requirePermission`、`resolveUserId`。不新建 cross-module 合同文件。
- tags 审计由路由层 `tagWriteContext(c)` 显式传入已认证管理员与
  `getClientIp(c)`（遵循 TRUSTED_PROXIES）。迁移前标签服务使用
  `system/services/audit-log.ts` 的 `logAudit`，经 `withActorContext`
  注入的请求上下文记录同样的主体与 IP，行为一致。 （更正：#735
  合并时曾误把另一个无调用方的同名函数 `platform/services/audit-log.ts#logAudit`
  当作原实现，把标签审计改成系统身份，
  导致审计丢失操作人；已在后续修复中恢复，并补「审计记录真实管理员」回归测试。
  直接读取可伪造的 `X-Forwarded-For` 不可接受。）
- tags 搜索事件为避免 `features → application/index → problems`
  运行时环，在功能内直接经 `modules/runtime` 出口登记 `search.index`
  任务，载荷与原 `enqueueSearchIndexTask` 一致。

## Alternatives considered

- 恢复隐式 `withActorContext`
  包裹：功能路由不经过管理员中间件，显式传参更清楚，且不依赖 ALS。
- 为 legal 新建 cross-module 合同文件：与精简目标相反，改为模块 `index.ts`
  补导出。

## Consequences

- 路由处理函数集合与迁移前完全一致；中间件仅新增
  `ALL /api/v1/admin/legal/*`（等价替代聚合层鉴权）。
- 删除 `platform/services/audit-log.ts` 中无调用方、恒记系统身份的同名
  `logAudit`， 避免与 `platform/system/services/audit-log.ts`
  中读取请求上下文的实现混淆。
- 搜索事件登记在 tags 与 `application/search-tasks.ts` 各有一份，待该能力下沉到
  `shared/` 后合并。
- `deno task check`、`check-all`、legal/tags/checkin/trainings/problems/access/platform/read-models/application
  域测试与共享测试全部通过。
