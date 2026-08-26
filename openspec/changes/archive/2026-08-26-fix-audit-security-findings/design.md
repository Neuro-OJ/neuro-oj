## Context

安全审计发现一批可操作问题：竞赛提交无速率限制、公开 recent 泄露竞赛提交、LLM 配额默认无限、judge 资源硬上限缺失、题目导入无限制、以及若干低风险加固项。本次变更跨 noj-core / noj-judge / noj-llm-gateway 三个模块，需要统一设计限流、配额默认值、judge 硬上限与结果合法性校验。

## Goals / Non-Goals

**Goals:**

- 堵住竞赛公平性绕过（公开 recent、竞赛 SSE、竞赛提交详情）。
- 为竞赛/客观题/题目导入增加速率限制。
- 为 LLM 网关提供默认配额与安全 fallback。
- 为 judge 增加资源硬上限与结果合法性校验。
- 完成低风险加固（checksum、缓存权限、Config Debug、临时文件清理）。

**Non-Goals:**

- 不修改 `llm_usage.request_messages` 完整 prompt 存储（设计决策）。
- 不改变 eval_token 协议（不做 jti 单次使用），仅增加监控。
- 不重构存储层或消息队列架构。

## Decisions

### D1: 速率限制复用现有 hardening 模块

在 `noj-core/src/lib/hardening-rate-limit.ts` 中新增：

- `enforceContestSubmissionRateLimit(c, userId)`：复用 `SUBMISSION_*` 阈值，或独立阈值（默认与普通提交一致）。
- `enforceObjectiveSubmitRateLimit(c, userId)`：独立阈值（如 60/min）。
- `enforceProblemCreateRateLimit(c, userId)`：如 30/min。
- `enforceProblemImportRateLimit(c, userId)`：如 10/min。

路由层在对应 handler 开头调用。理由：与现有 `enforceSubmissionRateLimit` 模式一致，Redis key 命名沿用 `ratelimit:*`，无需引入新依赖。

### D2: 公开 recent 排除竞赛提交

`listSubmissions` 增加可选参数 `excludeContest?: boolean`；`GET /submissions/public/recent` 传 `true`，SQL 条件追加 `contest_id IS NULL`。

`getSubmission` 增加竞赛可见性判断：若提交属于 OI running 竞赛且查看者非 owner/admin，则 `result` 返回 `null`。实现上在 `getSubmission` 内查询 `contests` 状态/类型（可复用 `getContest` 或轻量查询）。

### D3: LLM 默认配额

- 在 `noj-core` 初始化流程（`init:system` 或 `seed`）中幂等写入默认 `llm_quotas` 行。
- 在 `noj-llm-gateway/src/limits.ts` 的 `getQuota` 返回 `null` 时，使用环境变量 fallback（如 `NOJ_LLM_DEFAULT_GLOBAL_DAY_TOKENS`、`NOJ_LLM_DEFAULT_USER_DAY_TOKENS`），避免“缺失=无限”。

### D4: judge 资源硬上限

在 `noj-judge/src/dual/mod.rs` 的 `validate_runtime_config` 或 `evaluate_dual` 入口处，对 `runtime_config` 做 clamp：

- `evaluator.time_limit_ms = min(value, MAX_EVALUATOR_TIME_MS)`
- `evaluator.memory_limit_mb = min(value, 4096)`
- `solution.call_timeout_ms = min(value, MAX_SOLUTION_CALL_TIMEOUT_MS)`
- `solution.memory_limit_mb = min(value, 4096)`

常量在 `config.rs` 定义，支持环境变量覆盖。理由：core 配置可能缺失或消息被篡改，judge 必须兜底。

### D5: judge 结果合法性

- `build_judge_result` 增加状态白名单：未知状态映射为 `SystemError`。
- `score` 使用 `clamp(0, 10000)`。

### D6: 低风险加固

- `download.rs`：`verify_checksum` 在 expected 为 `None`/空时返回错误（或由调用方拒绝）。
- `cache.rs`：写入后设置文件权限 0600、目录 0700；rename 失败时删除临时文件。
- `config.rs`：为 `Config` 手写 `Debug`，对 `redis_url` 脱敏。
- `sse.ts`：竞赛 SSE 对非 admin 剥离 `user_id`。

### D7: eval_token 监控

不改协议。在 `noj-llm-gateway/src/routes/llm.ts` 中记录每次调用的来源 IP（已有 `x-forwarded-for`），并在同一 `submission_id` 的 token 出现多个不同来源 IP 时输出告警日志（或写入 `llm_usage` 的 `error_code` 标记）。后续可接告警系统。

## Risks / Trade-offs

- [速率限制可能误伤正常比赛高频提交] → 阈值与普通提交一致（120/min），足够宽松；如误伤可调参。
- [公开 recent 过滤后首页“最新评测”内容变少] → 可接受，竞赛提交本就不应公开。
- [LLM 默认配额可能过紧/过松] → 默认值写入 `.env.prod.example`，运维可调。
- [judge 硬上限可能截断合法长任务] → 默认 300s/60s 已远超常规 OJ 需求；如确有特殊题目可调环境变量。
- [getSubmission 隐藏 result 增加一次竞赛查询] → 仅对带 `contest_id` 的提交查询，影响面小。

## Migration Plan

1. 合并代码后，先部署 noj-core（限流、recent 过滤、配额种子）。
2. 再部署 noj-llm-gateway（fallback 配额、监控）。
3. 最后部署 noj-judge（硬上限、结果校验、缓存/checksum 加固）。
4. 回滚：各模块独立回滚；限流/过滤为纯增量，不破坏旧客户端。

## Open Questions

- LLM 默认配额的具体数值需与运营确认（当前先给保守值）。
- 竞赛提交限流是否需要在竞赛维度再加全局限流？先不做，观察滥用情况。
