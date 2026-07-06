## Context

Neuro OJ 测试体系有三层：noj-core 单元/服务/路由测试（PGlite 双模式）、noj-judge Docker E2E（Rust + bollard）、noj-tests 全链路 E2E（Deno HTTP API）。经过全面探索发现 CI 触发器被注释、pipeline 测试静默跳过、MQ 层零覆盖、安全配置未验证等关键问题。本方案聚焦修复已有但跑不起来的测试，并补齐关键盲区。

## Goals / Non-Goals

**Goals:**
- 让已有 E2E 测试真正运行（CI 触发 + 端口修复 + ignore 解除）
- 补齐 MQ 层单元测试（producer/consumer 核心边缘情况）
- 验证题目的时间/内存限制实际约束 Docker 容器
- 验证容器安全配置（pids_limit、ipc_mode、no-new-privileges）
- 扩展全链路评测状态机覆盖（MLE、RE、语法错误）

**Non-Goals:**
- 不新增功能 E2E（私信、榜单、重测、支持包上传）
- 不拆分 CI 管道（轻量/重量升级留到后续轮次）
- 不合并 Rust E2E 到 Deno 测试（已讨论决定保持分离）
- 不引入 MQ 协议 E2E 层（HTTP API 已覆盖协议路径）
- 不启用速率限制 E2E（Redis 状态清理和时序协调复杂度过高）

## Decisions

### D1: MQ 单元测试用 fake Redis（扩充）+ 真实 Redis（CI）

**选择**：本地优先用扩充版 fake Redis mock（从 `submissions.test.ts` 提取 + 新增 BRPOP/PUBLISH 支持），CI 中 fallback 到真实 Redis。

**备选**：引入 `ioredis-mock` npm 包。拒绝原因：Deno 兼容性未验证，且现有 fake Redis 模式已在同一 codebase 中成功使用。

**fake Redis 扩充内容**：
1. BRPOP：带超时 + 内存中 list 状态（与 LPUSH 共享）
2. PUBLISH：返回 integer 1
3. LPUSH 实际写入内存数组供断言检查

### D2: 不新建 MQ 协议 E2E 层

**选择**：通过 noj-tests 的 HTTP API 路径覆盖 MQ 协议——`POST /submissions` → judge → `GET /submissions/:id` 已经端到端验证了 MQ 路径。MQ 的边缘情况（16MB 限制、重连退避、非法消息跳过）在 noj-core 单元测试中用 fake Redis 覆盖。

**备选**：在 noj-tests 中增加直接 Redis 操作的协议测试。拒绝原因：测试实现细节而非用户可见行为；HTTP 全链路已覆盖正常路径；单元测试更适合边缘情况。

### D3: profile 测试 ignore: true → ignore: skip

**选择**：解除忽略并验证通过。诊断确认路由声明顺序正确、`getUserProfile` 实现完整、API 响应结构与测试断言匹配。标记为 ignore: true 是历史遗留。

### D4: checkin 并发测试恢复 + 降并发数 5→3

**选择**：恢复并发签到测试（验证 DB 唯一约束），并发数从 5 降到 3 减少极端情况。外层加 `Promise.race` + 10s 超时防止网络延迟误判。

### D5: e2e_problem_limits.rs 复用现有 common 模式

**选择**：完全复用 `tests/common/mod.rs` 的 `create_test_container`/`wait_container`/`is_e2e_enabled`。`_timeout_ms` 参数虽然当前未在 `create_test_container` 中使用，但 `wait_container` 的超时逻辑已覆盖超时场景。

### D6: 安全配置验证复用 test_pool_security_config

**选择**：在已有 `e2e_container_pool.rs` 的 `test_pool_security_config` 中追加 3 个断言，而非新建独立测试文件。该测试已通过 `PoolManager` 创建真实池容器并进行 inspect。

## Risks / Trade-offs

- **[Risk] CI 速度显著下降** — 每次 PR 跑 5-15min E2E → **Mitigation**：先让测试跑起来观察实际耗时。如果超过 10min，后续轮次拆分轻量/重量管道。
- **[Risk] profile 测试解除 ignore 后可能失败** — 可能是真实 bug → **Mitigation**：先在本地运行验证，如果失败则修复路由而非重新 ignore。
- **[Risk] fake Redis BRPOP 实现不精确** — 阻塞语义可能与真实 Redis 不一致 → **Mitigation**：CI 中有真实 Redis，fake Redis 仅用于本地 PGlite 模式。关键 BRPOP 测试（consumer 循环行为）优先在 CI 环境运行。
- **[Risk] MLE pipeline 测试可能影响其他容器** — OOM killer 行为不可控 → **Mitigation**：MLE 测试使用 50MB 内存限制，远低于主机内存。

## Open Questions

- E2E 全栈测试首次恢复后 CI 实际耗时是多少？观察后决定是否需要拆分
- profile 测试解除 ignore 后是否会暴露路由 bug？
