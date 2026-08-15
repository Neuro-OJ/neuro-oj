## Why

2026-08-15 全模块审计在 `main@31150781` 上确认 225 条真阳性发现。其中严重/高/中级共 76 条包含可被直接利用的存储型 XSS、存储层越权、评测消息永久丢失链、rejudge_seq 丢失、IP 防护失效、judge 沙箱纵深不足与多处限流缺口。必须在合入新功能前完成修复，避免安全与可靠性问题继续累积。

## What Changes

- **评测消息可靠投递（core + judge）**：任务与结果两侧均改为 BRPOPLPUSH 到 processing 列表，处理成功后 LREM 确认；失败/崩溃通过 processing 超时扫描重投主队列，配合 rejudge_seq/结果幂等实现 at-least-once；提交创建改为「事务写库 + 队列投递」的可恢复流程。
- **judge 沙箱与编排加固**：镜像/命令白名单复验、内存上限封顶与 0 值防护、zip 解压过程中实时限额、SIGTERM 优雅关闭、shutdown 与 BRPOP 竞态修复、Drop 清理与启动孤儿清扫、结果 payload 跨 chunk 解析修复、成功路径补回 rejudge_seq。
- **存储层越权修复（core）**：storage key 规范化 + 根目录约束，`support_package_storage_url` 改为仅允许服务端生成的受控 URL，阻断 local 路径穿越与 S3 跨对象读写。
- **认证、限流与封禁（core + ui）**：JWT 验证固定 HS256；`DATABASE_URL` 缺失在生产启动期失败；`TRUSTED_PROXIES` 校验移到系统设置初始化后；`X-Real-IP` 同样受可信代理约束；UI 代理透传客户端 IP/UA；注册、忘记/重置密码、私信发送、提交创建补限流；登录限流按用户 ID 规范化；IP 封禁对 unknown fail-closed；角色降级/封禁后不再信任 JWT 中的静态 role。
- **UI 安全与正确性**：搜索高亮移除 v-html 改为转义后分段渲染；SSR/降级净化器补齐协议黑名单与实体解码并移除 style 白名单；搜索分页参数、类型跳转、认证态错误处理、随机题目拉取、编辑器草稿残留、参赛者移除确认等一并修复。
- **文档与配置对齐（docs）**：修正 JudgeTask/镜像名/目录/密码策略/CLI/backup/RPC tuple 等与实现不符的文档；`scripts/dev/env.example` 移除已知密钥与默认管理员口令。

> 范围与审计 `summary.md` 的 P0/P1/P2 建议一致；低危/信息级（P3）留待后续清理。

## Capabilities

### New Capabilities

- `judge-message-reliability`: 评测任务/结果队列的 processing 确认、超时重投与幂等语义。
- `audit-fix-hardening`: 本次审计驱动的认证、限流、存储输入校验与 UI XSS 防护安全要求。

### Modified Capabilities

- `redis-message-queue`: 队列消费语义由 at-most-once 改为 at-least-once。
- `docker-sandbox`: 镜像/命令白名单、内存上限、zip 解压限制与孤儿容器清理。
- `judge-worker`: SIGTERM 处理、结果解析与 rejudge_seq 透传。
- `user-auth`: JWT 算法固定、封禁/角色变更后的 JWT 失效要求。
- `problem-management`: `support_package_storage_url` 仅接受服务端受控 URL。
- `object-storage`: 存储 key 规范化与根目录约束。
- `cookie-auth`: 代理透传客户端 IP/UA，保证后端 IP 限流与封禁生效。
- `global-search`: 搜索高亮不引入 XSS，分页参数一致。
- `email-provider`: mock 邮件在日志中不得泄露重置令牌。

## Impact

- **noj-core**：`main.ts`、`db/connection.ts`、`lib/jwt.ts`、`lib/storage/*`、`lib/rate-limit-env.ts`、`lib/email-providers/mock.ts`、`middleware/auth.ts`、`middleware/banlist.ts`、`middleware/login-rate-limit.ts`、`mq/*`、`services/submissions-*.ts`、`services/problems-*.ts`、`services/queue.ts`、`services/objective-questions.ts`、`services/messages.ts`、`services/search.ts`、`services/dashboard.ts`、`routes/auth.ts`、`routes/submissions.ts`、`routes/conversations.ts`、`services/seed-rbac.ts`、`deno.json` 及对应测试。
- **noj-ui**：`server/api/[...slug].ts`、`utils/sanitize.ts`、`components/feature/search/SearchResultItem.vue`、`composables/useSearch.ts`、`composables/useAuth.ts`、`composables/useApi.ts`、`pages/search.vue`、`pages/problems.vue`、`components/feature/RandomProblems.vue`、`components/editor/EditorWorkspace.vue`、`pages/admin/contests.vue` 等。
- **noj-judge**：`src/mq.rs`、`src/main.rs`、`src/drain.rs`、`src/dual/*.rs`、`src/sandbox/*.rs`、`docker/python/Dockerfile`、`Dockerfile.e2e` 及单元/集成测试。
- **docs**：`noj-docs/docs/**`、`README.md`、`scripts/dev/env.example`。
- **数据库**：如搜索索引、消息查询等性能修复需要新迁移；可靠投递不新增表，优先基于 Redis 列表实现。
