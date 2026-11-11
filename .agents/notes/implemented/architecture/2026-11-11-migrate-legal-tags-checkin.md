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
- tags 审计保持迁移前行为：原 `logAudit` 以系统身份（actor=null、IP
  "system"）记录，迁移后用等价的
  `TAG_AUDIT_CONTEXT`。工蜂初版改为记录真实管理员并直接读取
  `X-Forwarded-For`，既改变行为又可伪造 IP，已回退。
- tags 搜索事件为避免 `features → application/index → problems`
  运行时环，在功能内直接经 `modules/runtime` 出口登记 `search.index`
  任务，载荷与原 `enqueueSearchIndexTask` 一致。

## Alternatives considered

- 迁移时顺带修复标签审计不可见问题：属于行为变更，应单独提交，不混入结构迁移。
- 为 legal 新建 cross-module 合同文件：与精简目标相反，改为模块 `index.ts`
  补导出。

## Consequences

- 路由处理函数集合与迁移前完全一致；中间件仅新增
  `ALL /api/v1/admin/legal/*`（等价替代聚合层鉴权）。
- 已知问题：标签管理审计记在系统账号名下，默认审计列表排除系统账号，故不可见；修复时应记录真实管理员且
  IP 必须用 `getClientIp`。
- 搜索事件登记在 tags 与 `application/search-tasks.ts` 各有一份，待该能力下沉到
  `shared/` 后合并。
- `deno task check`、`check-all`、legal/tags/checkin/trainings/problems/access/platform/read-models/application
  域测试与共享测试全部通过。
