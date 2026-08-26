## Why

安全审计发现评测机与后端仍存在若干可被选手利用的公平性、DoS 与资源滥用问题：竞赛提交无速率限制、公开最近提交泄露竞赛得分、LLM 配额默认不设防、judge 资源上限缺失、题目导入无限制，以及一批低风险加固项。本次变更统一修复这些可操作项，排除已确认的 `llm_usage.request_messages` 完整 prompt 存储设计决策。

## What Changes

- 竞赛提交与客观题提交接入速率限制，防止刷爆评测队列。
- 公开“最近提交”接口排除竞赛提交，避免泄露 OI 隐藏分数与私有竞赛进度。
- LLM 网关增加默认配额种子与代码层 fallback，避免“无配额=无限”的默认状态。
- judge 侧增加 evaluator/solution 时间与内存硬上限，作为 core 配置失效时的最后防线。
- 题目创建/导入接口增加速率限制，缓解大包上传 DoS。
- eval_token 增加异常重放监控（不改变协议，不做单次使用）。
- 低风险加固：checksum 缺失拒绝、Config Debug 脱敏、缓存临时文件清理与权限、judge 结果 status 白名单、score 范围校验、竞赛 SSE 隐藏 user_id。
- 不修改 `llm_usage.request_messages` 完整 prompt 存储（设计决策）。

## Capabilities

### New Capabilities

- `llm-quota-defaults`: 为 LLM 网关提供默认配额种子与无配额时的安全 fallback。
- `judge-resource-hard-caps`: judge 侧对评测时间/内存的硬上限约束。
- `api-rate-limiting`: 为竞赛提交、客观题提交、题目创建/导入提供统一速率限制能力。

### Modified Capabilities

- `submission-list-api`: 公开最近提交列表排除竞赛提交；竞赛提交详情在 OI 进行期间对非 owner/admin 隐藏得分。
- `contest-participation`: 竞赛提交接口必须受速率限制保护。
- `objective-judging`: 客观题提交接口必须受速率限制保护。
- `problem-bundle-import`: 题目导入接口必须受速率限制保护。
- `docker-sandbox`: 支持包校验、缓存文件安全、结果状态/分数合法性等沙箱侧加固。
- `sse-endpoints`: 竞赛 SSE 对非管理员隐藏提交事件中的 user_id。

## Impact

- **noj-core**：`routes/contests.ts`、`routes/problems.ts`、`routes/submissions.ts`、`services/submissions/submissions-crud.ts`、`lib/hardening-rate-limit.ts`、`services/seed/seed-rbac.ts`（如需）、`lib/settings-registry.ts`（如需默认值）。
- **noj-judge**：`src/config.rs`、`src/sandbox/download.rs`、`src/sandbox/cache.rs`、`src/dual/mod.rs`、`src/dual/container.rs`、`src/sandbox/host_config.rs`。
- **noj-llm-gateway**：`src/limits.ts`、`src/routes/llm.ts`（监控）、`src/crypto.ts`（如需）、初始化/种子脚本。
- **配置/部署**：`.env.prod.example`、`docker-compose.prod.yml`（如需）。
- **测试**：noj-core 路由/服务测试、noj-judge 单元测试、noj-tests 跨模块 E2E。
