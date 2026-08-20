## Why

题目源码目录中 `submission_sample.py`（参考实现）与 `template.py`（前端 starter code）职责重复，模板索引靠硬编码文件名回退链（`template.py` → `submission_sample.py` → `submission.py`）。同时 `runtime_config.solution.entry` 是双容器引入时过度暴露的评测实现细节——SDK 以固定模块名 `user_solution` 加载入口文件（`host.py`），文件名对评测毫无影响，出题人无需也不应配置。本次将模板索引显式化到 `problem.json` 字段，`solution.entry` 完全移除并收敛为 judge 硬编码约定，同时删除 `submission_sample.py`。

## What Changes

- 删除 `noj-core/data/problems-src/{1001,1002,1003}/submission_sample.py`
- `problem.json`（题目包 manifest）新增顶层 `template` 字段，索引模板文件名（前端编辑器初始代码）；**缺省默认 `"template.py"`**，保证未声明该字段的旧题目兼容
- **`solution.entry` 完全移除**（**BREAKING**）：
  - core：`SolutionRuntime` 类型、`validateRuntimeConfig` 校验、管理端编辑器"入口文件名"输入框全部移除；三个题目的 `problem.json` 删除该字段
  - judge：`SolutionRuntime` 移除 `entry` 字段；`dual/mod.rs` 改为硬编码常量 `SOLUTION_ENTRY_FILE = "main.py"`——用户代码以 `main.py` 注入，SDK `--entry /workspace/main.py`（模块名固定 `user_solution`）
  - 历史消息/存量数据中的残留 `entry` 字段被 serde/校验忽略，不阻塞评测
- `getProblemTemplate()` 移除 `submission_sample.py` / `submission.py` 回退链，改为读 manifest `template` 字段（默认 `template.py`）
- **BREAKING**：模板读取不再回退参考实现——仅提供参考实现而未提供 `template.py` 的题目，`GET /api/v1/problems/:id/template` 返回 404
- 打包排除规则加入 `template.py`（评测包不含模板）
- 更新相关文档（AGENTS.md / noj-judge CLAUDE.md 的 JudgeTask 结构、出题人文档、statement 引用、E2E 断言、管理端编辑器）

## Capabilities

### New Capabilities

（无新 capability；模板索引并入 `problem-bundle-import`）

### Modified Capabilities

- `problem-bundle-import`: manifest 新增顶层 `template` 字段（默认 `"template.py"`）；题目源码目录不再包含参考实现 `submission_sample.py`，`template.py` 为模板唯一来源
- `problem-runtime-config`: `runtime_config` 结构移除 `solution.entry`；Solution 入口为 judge 硬编码约定（`main.py`），出题人不可配置

## Impact

- **noj-core**：`src/types/index.ts`（`SolutionRuntime` 移除 entry）、`src/services/problems-types.ts`（校验）、`src/services/support-package.ts`（`getProblemTemplate`）、`src/types/problem-bundle.ts`（manifest 类型 + 校验）、`src/routes/problems.ts`（注释）、`data/problems-src/*/problem.json`（3 个题目）、`data/problems-src/1001/statement.md`；core 测试约 40 处 fixture 清理 `entry` 键
- **noj-judge**：`src/types.rs`（`SolutionRuntime` 移除 entry + 示例 JSON）、`src/mq.rs`（示例 JSON）、`src/dual/mod.rs`（硬编码 `SOLUTION_ENTRY_FILE`）
- **noj-ui**：`components/editor/ProblemEditor.vue`（删除"入口文件名"输入框）
- **noj-tests**：`e2e/17_problem_template.test.ts`（回退断言改为 manifest 索引断言）；其余 fixture 的 `entry` 为运行时 JSON（服务端忽略），无需强制修改
- **noj-docs**：`docs/problemsetters/support-package.md`
- **AGENTS.md / noj-judge/CLAUDE.md**：JudgeTask 示例结构更新
- **openspec**：`specs/problem-bundle-import/`、`specs/problem-runtime-config/` delta
