## Context

当前 noj-judge 维护两条评测路径：

1. **单容器模式** (`JudgeMode::Single`)：用户代码与评测脚本（evaluate.py）运行在同一 Docker 容器中，通过 PoolManager 容器池管理生命周期。使用 `judge_image` / `judge_command` 配置。
2. **双容器模式** (`JudgeMode::Dual`)：Evaluator 容器运行评测脚本，Solution 容器运行用户代码，通过 NDJSON 协议双向通信。使用 `runtime_config` 配置。

双容器模式已在 PR #146 中实现并验证，提供了更好的安全隔离（用户代码无法接触评测脚本和测试数据）。维护两条路径增加了代码复杂度、测试负担，且 rejudge 路径存在 bug（总是走单容器模式，忽略 `runtime_config`）。

**项目尚未投产**，无需考虑存量数据迁移。所有样例题（1001/1002/1003）将同步切换为双容器实现。

## Goals / Non-Goals

**Goals:**
- 移除 `JudgeMode` 枚举，统一所有评测走双容器编排路径
- `runtime_config` 成为 problems 的必填字段
- 移除 noj-judge 中整个单容器代码路径（`pool/` 模块、`evaluate_with_pool` 等）
- 从 `JudgeTask` 中移除 `mode`、`judge_image`、`judge_command` 字段
- 从 `problems` 表中移除 `judge_image`、`judge_command` 列
- 修复 rejudge 路径缺少 `runtime_config` 的 regression
- 前端移除双容器模式开关，始终展示 runtime_config 配置 UI
- 样例题（1001/1002/1003）全部切换为双容器实现（evaluate.py 适配 NDJSON 协议）

**Non-Goals:**
- 不改变双容器的 NDJSON 协议本身
- 不改变 Evaluator/Solution 的镜像构建方式
- 不改变支持包缓存机制（缓存逻辑由 dual 路径内部复用）

## Decisions

### Decision 1: 全部走双容器编排，不复用单容器逻辑

**选择**：将所有评测统一到 `dual::evaluate_dual()` 路径，不复用 `evaluate_with_pool()` 的单容器逻辑。

**理由**：
- 单容器的 `PoolManager` 容器池机制与双容器的即时创建机制不兼容
- 双容器需要两个独立容器（Evaluator + Solution），与单容器的一个容器完全不同
- 保留两条路径的"适配层"比直接移除更复杂

**替代方案**：在 dual 内部兼容"无 Solution 容器"的退化模式（即 Evaluator 同时运行用户代码）。**否决**：这会重新引入安全隔离问题，且增加 dual 模块复杂度。

### Decision 2: 直接删除 judge_image / judge_command 列

**选择**：从 `problems` 表中删除 `judge_image` 和 `judge_command` 列，不做 deprecated 过渡。

**理由**：项目未投产，无存量数据需要迁移。样例题的配置直接在 seed 脚本中改为 `runtime_config` 格式。与其保留无用列增加 schema 复杂度，不如直接清理。

### Decision 3: 容器池移除

**选择**：完全移除 `pool/` 模块（PoolManager、容器预热、懒回补）。

**理由**：双容器模式不使用容器池——Evaluator 和 Solution 容器都是即时创建、用完即删。保留池模块只会增加死代码。

**影响**：
- 移除 `POOL_INITIAL_SIZE`、`POOL_MAX_SIZE`、`POOL_MIN_SIZE`、`POOL_IDLE_TIMEOUT`、`POOL_LABEL_PREFIX` 等环境变量
- 移除健康检查后台任务
- `POOL_MEMORY_MB`、`POOL_CPU`、`POOL_KILL_GRACE_SECONDS` 等与容器执行相关的配置保留（dual 路径仍需使用）

### Decision 4: JudgeTask 结构精简

**选择**：从 `JudgeTask` 中移除 `mode`、`judge_image`、`judge_command` 字段，`runtime_config` 从 `Option` 变为必填。

新 `JudgeTask` 结构（Rust 侧）：
```rust
pub struct JudgeTask {
    pub submission_id: String,
    pub problem_id: String,
    pub runtime_config: RuntimeConfig,  // 不再是 Option
    pub download_url: Option<String>,
    pub language: String,
    pub code: String,
    pub file_name: Option<String>,
    pub rejudge_seq: Option<i64>,
}
```

**理由**：简化消息格式，消除条件分支。

### Decision 5: 前端 ProblemEditor 改造

**选择**：移除 `dualMode` ref 和开关 UI，始终渲染 RuntimeConfig 配置区域。移除 `judge_image` / `judge_command` 选择器，改为在 RuntimeConfig 内选择 Evaluator 镜像和命令。

**理由**：不再有"是否启用双容器"的概念——所有题目都是双容器。

### Decision 6: 样例题同步切换

**选择**：将 1001/1002/1003 的 evaluate.py 全部改为双容器协议实现（通过 NDJSON 与 Solution 容器通信），seed 脚本中使用 `runtime_config` 替代 `judge_image`/`judge_command`。

**理由**：样例题是功能验证的基准，必须与新的评测模式一致。未投产意味着无需兼容旧格式。

## Risks / Trade-offs

- **[Risk] 容器启动延迟增加**：移除容器池后，每次评测都需要即时创建两个容器，启动延迟从 <100ms（预热容器）增加到 ~1-2s。→ **Mitigation**: 双容器模式本就即时创建容器（PR #146 设计如此），实际延迟已可接受。Docker 层的镜像缓存可减少拉取开销。

- **[Trade-off] 简单题目也需要配置 Solution 容器**：即使题目不需要独立的 Solution 容器（如纯算法题），也必须配置 `runtime_config.solution`。→ 这是统一的代价——简化系统换取配置复杂度。对于不需要 SDK 调用的简单题目，Solution 容器可以是一个最小化的 Python 运行时，evaluate.py 通过 NDJSON 协议发送输入、接收输出。

- **[Trade-off] 样例题复杂度增加**：从单容器 `subprocess.run()` 迁移到双容器 NDJSON 协议，evaluate.py 需要适配。→ 这是有意的复杂度转移——样例题作为最佳实践参考，应展示正确的双容器用法。

## Migration Plan

### 步骤 1: 样例题 + seed 更新
- 更新 1001/1002/1003 的 evaluate.py 为双容器 NDJSON 协议
- 更新 seed 脚本：使用 `runtime_config` 替代 `judge_image`/`judge_command`
- 更新 `build-packages.ts`（如有需要）

### 步骤 2: 数据库 Schema 更新
- 创建 Drizzle 迁移：删除 `problems.judge_image`、`problems.judge_command` 列，`runtime_config` 改为 NOT NULL

### 步骤 3: noj-core 代码更新
- 修改 `types/index.ts`：移除 `JudgeMode`，`RuntimeConfig` 相关类型保留
- 修改 `services/submissions.ts`：移除模式判断，始终使用 `runtime_config`
- 修改 `services/problems.ts`：移除 `judge_image`/`judge_command` 字段，`runtime_config` 必填校验
- 修复 rejudge 路径（`rejudgeSubmission`、`rejudgeProblemSubmissions`）

### 步骤 4: noj-judge 代码更新
- 移除 `JudgeMode` 枚举、`pool/` 模块
- 简化 `runner.rs`：只保留 dual 相关逻辑 + `process_output()`
- 简化 `main.rs`：移除模式分流，始终调用 dual 路径
- 清理不再需要的环境变量

### 步骤 5: noj-ui 代码更新
- 移除 `ProblemEditor.vue` 中的 `dualMode` 开关和相关逻辑
- 移除 `judge_image`/`judge_command` 表单字段
- 始终渲染 RuntimeConfig 表单

### 步骤 6: 测试更新
- 更新 noj-judge 单元测试（移除 `JudgeMode::Single` 引用、pool 测试）
- 更新 noj-core 服务测试
- 更新 E2E 测试

### 回滚策略
- 代码回滚：git revert 整个 PR
- 数据库回滚：Drizzle 迁移可反向（加回 `judge_image`/`judge_command` 列，`runtime_config` 改回 nullable）
- 未投产：无生产数据风险

## Open Questions

（全部已澄清——样例题全部切换，无存量数据迁移需求。）
