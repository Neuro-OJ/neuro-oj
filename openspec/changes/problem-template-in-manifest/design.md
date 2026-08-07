## Context

题目源码目录 `data/problems-src/<id>/` 当前每个题目包含 `problem.json`（manifest）、`statement.md`、`evaluate.py`、`visible.jsonl`、`hidden.jsonl`、`template.py`（前端 starter code）、`submission_sample.py`（参考实现）。现状：

- 模板索引靠硬编码回退链 `["template.py", "submission_sample.py", "submission.py"]`（`src/services/support-package.ts:192`），文件名约定隐式且职责混淆。
- `runtime_config.solution.entry`（出题人必填）实际只是 **judge 内部实现细节**：`noj-judge/src/dual/mod.rs:196-224` 以 `entry` 为文件名注入用户代码，SDK 以 `--entry` 路径加载；`noj-judge/sdk/solution/noj_solution_sdk/host.py:218-233` 用 `importlib.util.spec_from_file_location("user_solution", entry_path)` 加载——**模块名固定，文件名对评测无任何影响**。
- 历史：单容器时代 JudgeTask 无 entry（顶层 `judge_image/judge_command/...`）；双容器引入（PR #146）时把 `solution.entry` 做成必填，是过度暴露评测实现细节。
- 模板内容不落库、不进评测包，`GET /api/v1/problems/:id/template` 从源码目录实时读取（dev 模式）。

变更目标：`solution.entry` **完全移除**（类型、校验、UI、数据），Solution 入口收敛为 judge 硬编码约定（固定文件名 `main.py`）；`template.py` 成为源码目录唯一"代码文件"，模板索引显式化到 manifest（`template` 字段，缺省 `"template.py"`）；删除全部 `submission_sample.py`。

## Goals / Non-Goals

**Goals:**

- 删除 `data/problems-src/{1001,1002,1003}/submission_sample.py`
- 从 `RuntimeConfig` 类型（core + judge）、结构校验、管理端 UI、题目数据中**完全移除** `solution.entry`
- judge 硬编码 Solution 入口：用户代码以固定文件名 `main.py` 注入，SDK `--entry /workspace/main.py`（模块名已固定 `user_solution`）
- manifest 新增 `template` 字段（缺省 `"template.py"`），`getProblemTemplate()` 按字段索引读取，移除回退链
- 打包排除规则加入 `template.py`（评测包不含模板）
- 同步更新文档（AGENTS.md / CLAUDE.md 的 JudgeTask 结构、出题人文档、statement 引用、E2E 断言、管理端编辑器）

**Non-Goals:**

- 模板内容落库或随支持包存储（保留"源码目录实时读取"机制，生产化 TODO 不在本次范围）
- 多语言模板支持（模板接口 `language` 固定 `python3`）
- DB 迁移/回填存量 `runtime_config` 中的残留 `entry` 字段（JSONB 宽松，serde/校验均忽略未知字段，不阻塞评测）

## Decisions

**D1: manifest 新增顶层 `template` 字段，缺省 `"template.py"`**

`ProblemBundleManifest`（`src/types/problem-bundle.ts:45`）新增 `template?: string`；`validateBundleManifest` 校验为纯文件名（不含 `/`、`\`、`..`）。读取侧 `getProblemTemplate()` 优先读题目源目录的 `problem.json` 取 `template` 字段，缺省 `"template.py"`，再读对应文件。

- 备选：保留硬编码 candidates——否决，正是本次要消除的隐式约定。
- 备选：模板内容存入 DB 新列——否决，超出本次范围（Non-Goals）。

**D2: `solution.entry` 完全移除，judge 硬编码入口**

依据：`host.py` 以固定模块名 `user_solution` 加载入口文件，文件名不影响评测；提交时 core 已按 `LANGUAGE_EXT_MAP`（python3 → `main.py`）推断展示用文件名。因此：

- **core**：`src/types/index.ts` 的 `SolutionRuntime` 移除 `entry` 字段；`src/services/problems-types.ts` 移除 `solution.entry` 校验；`submissions-crud.ts` / `submissions-rejudge.ts` 构造 JudgeTask 无 entry 逻辑（原样透传，类型变化即可）；`src/routes/problems.ts` 相关注释同步
- **judge**：`src/types.rs` 的 `SolutionRuntime` 移除 `entry` 字段（serde 默认忽略旧消息中的未知字段，历史消息兼容）；`src/dual/mod.rs:196-224` 改为硬编码常量 `SOLUTION_ENTRY_FILE: &str = "main.py"`——注入用户代码与 SDK `--entry /workspace/main.py` 均使用该常量
- **数据**：三个 `problem.json` 的 `runtime_config.solution.entry` 字段删除
- **UI**：`components/editor/ProblemEditor.vue` 删除"入口文件名"输入框（`solutionEntry` ref 及模板行）

硬编码文件名选择 `main.py`：与 `LANGUAGE_EXT_MAP` 的 python3 默认一致，语义统一。

- 备选：保留 entry 为可选字段 + 评测时 core 覆盖——用户否决，要求彻底移除。
- 备选：judge 读 JudgeTask.file_name——`file_name` 语义是界面展示（submissions 表列），与注入名解耦更清晰；硬编码满足"出题人不可见"且实现最简。

**D3: 打包排除规则加入 `template.py`**

`buildProblemPackage` 的 zip `-x` 列表追加 `template.py`。模板仅供前端编辑器使用，不属于评测内容；评测包保持纯净。风险：未来若改为"模板随支持包分发"（`support-package.ts:185` TODO），需调整该规则。

**D4: 模板读取函数签名不变，内部改为读 manifest**

`getProblemTemplate(problemNumber)` 保持对外签名，内部读 `data/problems-src/<number>/problem.json` 的 `template` 字段（缺省 `"template.py"`）。缺失 → null → 路由层 404。不再尝试 `submission_sample.py` / `submission.py`。

**D5: 文档与测试同步更新**

- `AGENTS.md` §1.3 与 `noj-judge/CLAUDE.md` 的 JudgeTask 示例：移除 `solution.entry`，注明 Solution 入口为 judge 硬编码 `main.py`
- `noj-docs/docs/problemsetters/support-package.md`：参考实现段落改写为 `template` 字段索引说明；移除 entry 说明
- `data/problems-src/1001/statement.md:112` 的参考实现引用删除/改写
- `noj-tests/e2e/17_problem_template.test.ts`：断言改为"按 manifest.template 读取 template.py"
- core 测试 fixture（约 40 处 `entry: "submission_sample.py"`）：逐一移除 `entry` 键（类型移除后字面量多余属性会触发 TS 检查，必须清理）

## Risks / Trade-offs

- [BREAKING：仅提供参考实现而未提供 template.py 的题目，模板接口 404] → 本次三个题目均有 `template.py`；出题人文档明确模板为必维护文件
- [存量 DB 题目 runtime_config 残留 `entry` 字段] → JSONB 与 serde 均忽略未知字段；不阻塞评测，无需迁移
- [旧版 judge 与新版 core 混布（或反之）时 entry 字段不一致] → 字段移除后旧版 judge 仍能反序列化无 entry 消息（serde 缺省为默认值？entry 无 default → 旧 judge 反序列化失败）。**部署顺序**：先部署新版 judge 再部署新版 core，或同批部署；E2E/CI 全链路验证覆盖
- [打包排除 template.py 后，未来"模板随包分发"需调整规则] → 当前模板读取不依赖评测包，无功能影响
- [`submission*` 排除规则保留] → 防御未来重新引入参考实现文件

## Open Questions

无（变更边界已与用户确认：entry 彻底移除 + judge 硬编码、manifest 索引模板、删除参考实现、文档更新）。
