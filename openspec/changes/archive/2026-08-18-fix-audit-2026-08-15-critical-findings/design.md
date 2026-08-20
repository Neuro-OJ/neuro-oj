## Context

审计基线 `main@31150781`，225 条真阳性。本变更覆盖严重/高/中 76 条，横跨 noj-core、noj-ui、noj-judge、docs。现状核心问题：MQ 两侧 at-most-once、存储 URL 未校验、UI 存在 v-html XSS、IP 防护被代理/X-Real-IP 绕过、judge 沙箱信任消息输入。

## Goals / Non-Goals

**Goals:**
- P0/P1 全部严重与高危修复；P2 中危修复（限流、TOCTOU、幂等、文档漂移、性能热点中低风险部分）。
- 不破坏现有 API 契约，必要时以 400/403/429 收紧不安全行为。
- 修复可测试：core 单元/路由测试、judge 单元测试、ui 构建与 lint。

**Non-Goals:**
- 低危与信息级 149 条（P3）不纳入本次变更。
- 不引入 Kafka 等新 MQ 基础设施；可靠投递基于 Redis 列表。
- 不重写 community.ts 等巨型文件（仅记录，暂缓拆分）。

## Decisions

1. **可靠投递用 Redis processing 列表 + sweeper**：judge 与 core 各自 BRPOPLPUSH，成功后 LREM；core 启动后按 60s 间隔扫描两队列的 processing 列表并重投超时消息。相比显式 ACK，改造最小且无需新依赖。
2. **幂等以 `submission_id + rejudge_seq + status` 为准**：core 的 `saveEvaluationResult` 在事务内做条件更新/去重，重复消息直接跳过，避免统计双计。
3. **存储 URL 治理分层**：`parseStorageUrl` 做语法白名单，provider 做 key 规范化 + resolve 边界校验；`create/updateProblem` 拒绝客户端直传 `support_package_storage_url`（仅 upload/support-package 流程可生成），兼容旧数据按 `noj-storage://` 受控前缀读取。
4. **IP 解析统一走可信代理链**：`X-Real-IP` 只在直连对端命中 `TRUSTED_PROXIES` 时采用；UI Nitro 透传原始 XFF/X-Real-IP/UA。unknown 客户端 IP 对受保护端点按写请求 fail-closed。
5. **JWT/权限收紧**：`jwtVerify` 固定 `algorithms: ['HS256']`；auth 中间件对封禁用户拒绝请求；删除对 JWT `role` claim 的权限短路，客观题统一走 `assertPermission`。
6. **judge 输入白名单**：镜像前缀 + 命令白名单 + `memory_limit_mb` 上下限 + `network.enabled` 默认拒绝；zip 用 `Read::take(MAX+1)` 实时限额。
7. **shutdown 语义**：`tokio::signal` 同时监听 SIGTERM/SIGINT；drain 超时从下载/启动/时间限制推导；BRPOP 与 shutdown 竞态通过 BRPOPLPUSH + 处理中列表兜底。

## Risks / Trade-offs

- [processing 列表无跨实例锁] → 超时重投可能产生重复，由幂等吸收。
- [收紧 problem 输入可能影响现有客户端] → 仅客户端直传 URL 被拒；服务端 upload 与构建流程保持可用，并在迁移窗口返回明确错误。
- [judge 镜像白名单需与运行时镜像部署同步] → 默认白名单从 `JUDGE_IMAGE_PREFIX` 环境变量派生，文档同步。
- [76 条范围大，测试耗时] → 按模块分任务提交，先 core 后 judge/ui，最后 docs。

## Migration Plan

1. 部署顺序：先 core（幂等 + storage 校验 + MQ 确认），再 judge（白名单 + 可靠消费 + rejudge_seq），最后 ui/docs。
2. 无数据迁移破坏；新增搜索索引迁移按需追加。
3. 回滚：processing 列表可保留旧消息；旧 judge 读主队列仍可用，新 core 兼容旧消息。

## Open Questions

- 中危性能项（物化视图节流、dashboard 缓存、社区搜索索引）是否在本 PR 全量落地，还是拆后续变更；当前按「能低风险修复就修」执行。
