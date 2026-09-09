# NOJ 测试增强路线图设计

> Status: implemented
> Date: 2026-09-08
> 范围：noj-core / noj-ui / noj-llm-gateway / noj-judge / noj-tests

## 1. 背景与问题

NOJ 已有较完整的测试体系：noj-core 142 个测试文件、noj-judge 178 个测试点、noj-ui 已有纯工具函数单测、noj-tests E2E 按 Domain 拆分、noj-llm-gateway 已有 replay 测试。但仍有以下增强空间：

- **覆盖不足**：noj-ui 只有纯工具函数测试，组件/composable 基本未覆盖；noj-core 的 event-bus、sse-stream、storage/factory、seed-system、routes/sse、CLI 等模块缺少针对性测试。
- **可靠性**：存在依赖真实 PG/S3 的静默跳过；部分测试断言偏弱，只验证状态码/字段存在，未验证业务副作用。
- **速度**：E2E 与 core 全量测试耗时较长，缺少统一慢测试基线与分组均衡。
- **测试类型单一**：以单元/集成/E2E 为主，属性测试、模糊测试、性能基准、LLM 回放扩展不足。

## 2. 目标与非目标

### 目标

1. 分阶段补齐各模块测试覆盖，达到以下覆盖率目标（作为报告与趋势跟踪，不设 CI 硬门禁）：
   - noj-core ≥ 75%
   - noj-ui 关键 composables ≥ 60%
   - noj-llm-gateway ≥ 80%
   - noj-judge ≥ 80%
2. 提升测试可靠性：消除静默跳过、减少 flaky、增强断言。
3. 缩短测试耗时：建立慢测试基线并持续优化。
4. 引入更丰富的测试类型：属性、模糊、性能、回放。

### 非目标

- 不在 CI 中设置覆盖率硬门禁（用户明确选择“仅目标/报告，不设硬门禁”）。
- 不改变现有业务行为，不修改 `deno.lock` / `Cargo.lock` 手动内容。
- 不重写现有测试框架；UI 组件测试引入 Vitest 时与现有 Deno 测试并存。

## 3. 成功标准

- 各模块覆盖率报告达到上述目标值。
- 静默跳过清单可查，新增测试不引入静默跳过。
- 慢测试基线落盘，Phase 5 后对比有改善。
- 每个横切方向（可靠性/加速/新测试类型）至少落地 1-2 个具体改进。

## 4. 路线图总览

| 阶段 | 主题 | 核心交付 |
|---|---|---|
| Phase 0 | 测试基线 | 统一覆盖率报告、静默跳过清单、慢测试基线 |
| Phase 1 | noj-core 低覆盖补测 | event-bus、sse-stream、storage/factory、seed-system、routes/sse、CLI 等 |
| Phase 2 | noj-ui 组件/composable | composables 逻辑测试 + 核心组件交互测试 |
| Phase 3 | gateway + judge 补强 | gateway 限流/计费/Provider 分支；judge 边界与错误路径 |
| Phase 4 | E2E 异常场景 | 异常/恢复/并发/安全场景 |
| Phase 5 | 横切增强 | 可靠性、CI 加速、属性/模糊/性能/回放 |

设计原则：

- 每个阶段独立可交付、可验收，不阻塞其他阶段。
- 覆盖率目标只做报告与趋势跟踪，不设 CI 硬门禁。
- 优先补“能抓住真问题”的测试，避免为凑覆盖率写无效断言。

## 5. 阶段详情

### Phase 0：测试基线

**目标**：为后续阶段建立可衡量基线。

**交付物**：

1. 统一覆盖率报告脚本 `scripts/coverage-report.ts`：
   - 聚合 noj-core / noj-ui / noj-llm-gateway 的 Deno coverage。
   - noj-judge 使用 `cargo llvm-cov`（环境可用时）；不可用时先用测试数量 + 关键路径清单代替。
2. 静默跳过清单：
   - 扫描测试中的 `ignore` / `skip` / 环境变量守卫。
   - 输出“哪些测试没真正跑”的报告。
3. 慢测试基线：
   - 记录各模块测试耗时，作为 Phase 5 加速的对比基准。

**验收**：

- 一条命令生成覆盖率报告。
- 静默跳过清单可查。
- 慢测试基线落盘。

### Phase 1：noj-core 低覆盖补测

**目标**：noj-core 覆盖率提升到 ≥ 75%。

**重点补测模块**：

- `src/lib/event-bus`、`src/lib/sse-stream`（若存在）
- `src/shared/storage/factory` 与存储 Provider 边界
- `src/domains/system` 的 seed-system / 系统初始化
- `src/domains/contest/routes/sse.ts`、`src/domains/community/routes/sse.ts`
- `scripts/noj.ts` CLI 命令（migrate / init / bootstrap / problems 等）
- 其他低覆盖 shared 模块：config、email-providers、metrics 的边界分支

**测试类型**：单元 + 集成（PGlite/PG），沿用 `deno task test:domain <domain>` 约定，测试文件按 Domain 组织。

**验收**：

- core 覆盖率报告 ≥ 75%。
- 新增测试不引入静默跳过。
- 关键 SSE/CLI/存储路径有断言。

### Phase 2：noj-ui 组件/composable 测试

**目标**：关键 composables 覆盖率 ≥ 60%，核心组件有交互/冒烟测试。

**分两步走**：

- **2a：composables 逻辑测试（Deno）**
  沿用 `deno test -A tests/`，通过 mock Nuxt auto-import（`useState` / `useFetch` / `useRoute` 等）测试 `useApi`、`useAuth`、`usePolling`、`useProblemFilters`、`useSearch`、`useContests`、`useMessages` 等关键 composables 的业务逻辑。
- **2b：核心组件测试（引入 Vitest + @vue/test-utils）**
  为 `ProblemFilterBar`、`CheckInCard`、`SubmissionResult`、`CommunityCommentCard`、`ContestRankingTable` 等 5-10 个核心组件补交互测试。新增独立 `deno task test:components`（或 npm script），与现有 Deno 纯工具测试并存。

**验收**：

- 关键 composables 覆盖率 ≥ 60%。
- 至少 5-10 个核心组件有交互测试。
- CI 中组件测试作为可选/独立 job，不阻塞主流程。

### Phase 3：noj-llm-gateway + noj-judge 补强

**目标**：gateway 覆盖率 ≥ 80%，judge 覆盖率 ≥ 80%。

**gateway 重点**：

- 限流：窗口/额度/并发/超限 429
- 计费与审计：billed-token、用量落库、审计脱敏
- Provider 适配：现有 replay 测试扩展更多 Provider 与错误分支（超时、5xx、畸形响应）
- 配置/密钥：加密、环境变量缺失、非法配置

**judge 重点**：

- 单元测试补边界：ZIP 解析（路径穿越、条目数、单文件/总大小限制）、资源限制（内存/CPU/超时）、结果解析、错误路径、并发/取消
- Docker E2E 补异常：评测器崩溃、无结果、超时、网络能力、双容器失败、支持包缺失

**验收**：

- gateway/judge 覆盖率报告达标。
- 新增测试覆盖关键错误分支。
- judge 资源测试继续自建自清。

### Phase 4：noj-tests E2E 异常/恢复/并发场景

**目标**：跨模块 E2E 从“主流程正确”扩展到“异常/恢复/并发/安全”场景。

**重点场景**：

- 评测失败/超时/重试/重测并发
- MQ 消息乱序/重复/非法消息容错
- 竞赛防作弊：并发提交限额、SSE 信息泄露、self-test 门禁
- 存储故障：S3 不可用、presigned URL 过期
- 限流/429、密码爆破锁定
- 浏览器关键流程异常：注册验证失败、登录失败、提交失败反馈

**验收**：

- 新增 E2E 按 Domain 组织。
- 关键安全/恢复场景有回归测试。
- 不破坏现有 E2E 分组并行。

### Phase 5：横切增强

**可靠性**：

- 消除静默跳过：本地/CI 报告显式列出 skip；必须环境缺失的测试改为显式 fail 或汇总报告。
- 去 flaky：对已知不稳定测试加重试/等待策略；资源测试自建自清。
- 增强断言：从“状态码/字段存在”提升到“业务结果/副作用/审计”断言。

**加速**：

- core 并行分片优化、E2E 分组均衡、judge sccache 复用、UI 测试并行。
- 参考目标：E2E 全量 < 10min、core 并行 < 5min（作为趋势参考，不设硬门禁）。

**新测试类型**：

- 属性测试：排序/解析/分页/序列化（fast-check 或自研）。
- 模糊测试：ZIP/输入解析（judge 可用 proptest/cargo-fuzz；core 用随机输入）。
- 性能/基准：搜索/榜单/队列基准（已有 `tests/perf/`，可扩展）。
- LLM 回放：扩展 Provider/错误/限流快照。

**验收**：

- 每个横切方向至少落地 1-2 个具体改进。
- 慢测试基线对比有改善。

## 6. 风险与开放问题

- **UI 组件测试工具链**：引入 Vitest 会增加 Node 工具链；若团队希望保持纯 Deno，可先只做 composables 逻辑测试，组件测试延后。
- **Rust 覆盖率工具**：`cargo llvm-cov` 依赖 nightly/额外安装；不可用时以测试数量 + 关键路径清单代替，不阻塞路线图。
- **静默跳过治理**：部分测试依赖真实 PG/S3，完全消除需要测试替身或显式 skip 汇总，工作量集中在 Phase 5。
- **E2E 稳定性**：新增异常/并发场景可能引入 flaky，需配合重试与资源清理策略。

## 7. 后续步骤

本设计文档经评审后，使用 writing-plans 技能为每个阶段生成独立实施计划。建议按 Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 顺序推进；每个阶段可独立启动。
