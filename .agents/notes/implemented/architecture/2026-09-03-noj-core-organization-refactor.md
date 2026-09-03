# Agent Note: noj-core 组织架构重构（shared 共享层 + domains 域自包含）

Status: implemented

## Problem

noj-core 原有 `src/lib/`、`src/middleware/`、`src/mq/`、`src/routes/`、`src/services/`、`src/types/` 等横向目录将所有业务混在一起。跨域复用与业务归属不清晰：RBAC、认证、题目、提交、社区、系统设置等代码彼此深路径引用，路由层逐个 import，测试仍停留在顶层 `tests/`，新增功能时难以判断“某段代码属于哪个域/共享层”。

## Decision

采用“域归属收拢 + 共享层分类”两层结构：

- 新建 `src/shared/`：只放无业务归属的跨域基础设施，分为 `base/`、`config/`、`db/`、`http/`、`mq/`、`sse/`、`rate-limit/`、`security/`、`middleware/`。
- 新建 `src/domains/<domain>/`：每个域自包含 `routes/`、`services/`、`middleware/`、`mq/`、`types/`、`tests/`。域间只允许通过 `domains/<domain>/index.ts` 门面导入。
- 路由域自装配：每个有路由的域提供 `routes/index.ts`，`app.ts` 只按域挂载。
- 测试随域迁移：共享层测试在 `tests/shared/`，域测试在 `src/domains/<domain>/tests/`。
- 域类型按所有权拆分：catalog 持有 RuntimeConfig/题目类型，identity 持有 RBAC/权限，submission 持有评测协议/自测，其余类型归各所属域。
- 静态检查强制 `src/shared/**` 不得反向依赖 `src/domains/**`；生产代码跨域只能走门面；`src/domains/<domain>/tests/**` 允许跨域深导入以构造集成测试。

实施中按用户确认做了几处“拆解依赖”而非硬塞 shared 的决策：

- 依赖系统设置的限流环境/中间件留在 system 域，不放入 `shared/rate-limit` 或 `shared/middleware`。
- 依赖系统设置的存储/邮件能力迁入 system 域，不放入 `shared/storage`/`shared/email`。
- Actor RequestContext（AsyncLocalStorage）依赖 system 的 `getClientIp`，迁入 system 域。
- `shared/db/schema/submission.ts` 用本地字面量类型别名替代 domains 导入，避免 shared → domain 反向依赖。

## Alternatives considered

- 只移动文件不改依赖方向：无法解决 shared → domain 的循环/反向依赖，也没有强制边界。
- 把所有工具都留在 `src/lib/` 并只在文档里说明归属：物理结构与实际归属仍不一致，后续仍会深路径引用。
- 把 schema 表定义也拆进各域：改动数据库层过大，且 schema 仍需要跨域表引用，本次保留在 `shared/db/`。
- 测试继续全部留在顶层 `tests/`：会与域目录脱节，无法“打开域即见测试”。

## Consequences

- 新代码应按域归属放置；跨域复用先判断是否适合进 `src/shared/`，若依赖具体域业务则留在对应域。
- `scripts/check-domains.ts` 提供生产代码域边界与 shared 反向依赖检查；CI `check-all` 包含该检查。
- `scripts/gen-route-catalog.ts` 现在扫描 `src/domains/*/routes/*.ts`（不含 `routes/index.ts`）。
- 测试分片命令与 CI 已更新为包含 `src/domains/*/tests`。
- 遗留 `src/lib/`、`src/services/`、`src/types/`、`src/mq/` 等目录已清空并删除，后续文档/注释不再引用旧路径。
- 该重构不修改数据库 schema、API 路径或业务行为；后续新增域时需同步更新 `domain-boundaries.md` 与 Agent Note 中的目录职责表。
