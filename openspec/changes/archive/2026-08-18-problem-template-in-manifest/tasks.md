## 1. 题目源目录清理

- [x] 1.1 删除 `noj-core/data/problems-src/1001/submission_sample.py`
- [x] 1.2 删除 `noj-core/data/problems-src/1002/submission_sample.py`
- [x] 1.3 删除 `noj-core/data/problems-src/1003/submission_sample.py`

## 2. solution.entry 移除（core）

- [x] 2.1 `src/types/index.ts`：`SolutionRuntime` 移除 `entry` 字段（同步检查 `src/types/problems.ts` re-export）
- [x] 2.2 `src/services/problems-types.ts`：`validateRuntimeConfig` 移除 `solution.entry` 校验项
- [x] 2.3 `src/routes/problems.ts` 及涉及 entry 的注释清理（提交/题目路由）
- [x] 2.4 清理 core 测试 fixture 中的 `entry` 键（约 40 处：`tests/services/`、`tests/routes/`、`tests/mq/`、`tests/perf/` 等，逐一移除，保证类型检查通过）

## 3. solution.entry 移除（judge 硬编码）

- [x] 3.1 `noj-judge/src/types.rs`：`SolutionRuntime` 移除 `entry` 字段；示例 JSON（3 处）更新
- [x] 3.2 `noj-judge/src/mq.rs`：示例 JSON 更新（如有）
- [x] 3.3 `noj-judge/src/dual/mod.rs`：新增硬编码常量 `SOLUTION_ENTRY_FILE = "main.py"`；注入用户代码与 SDK `--entry /workspace/main.py` 改用常量（删除 `runtime_config.solution.entry` 引用）
- [x] 3.4 `cargo fmt` + `cargo clippy` + `cargo test`（单元测试）通过

## 4. Manifest 与模板索引（noj-core）

- [x] 4.1 `src/types/problem-bundle.ts`：`ProblemBundleManifest` 新增 `template?: string`；`validateBundleManifest` 校验 `template` 为纯文件名（不含 `/`、`\`、`..`），非法 → BadRequestError
- [x] 4.2 三个题目的 `problem.json` 新增 `"template": "template.py"`，并移除 `runtime_config.solution.entry` 字段
- [x] 4.3 `src/services/support-package.ts`：`getProblemTemplate()` 改为读取 `data/problems-src/<number>/problem.json` 的 `template` 字段（缺省 `"template.py"`），再读对应文件；移除 `submission_sample.py` / `submission.py` 回退链
- [x] 4.4 `src/routes/problems.ts`：模板路由注释更新（不再提及 submission_sample.py 回退）

## 5. 打包规则

- [x] 5.1 `scripts/noj.ts` 的 `buildProblemPackage` zip 排除列表追加 `template.py`（评测包不含模板）

## 6. 前端与管理端（noj-ui）

- [x] 6.1 `components/editor/ProblemEditor.vue`：删除 `solutionEntry` ref、"入口文件名"输入框及其校验/提交逻辑（`runtime_config.solution` 构造不再包含 entry）

## 7. 测试更新

- [x] 7.1 `noj-tests/e2e/17_problem_template.test.ts`：断言与注释改为"按 manifest.template 读取 template.py"（1003 断言 `a + b` 从 template.py 内容获取）
- [x] 7.2 `noj-core/tests/services/support-package.test.ts`：模板用例适配新读取逻辑（manifest 缺省 template 字段 → 默认 template.py；非法 template 值 → 400）
- [x] 7.3 运行 noj-core 相关单测（`deno task test` 或分片）与 noj-judge 单测确认无回归
- [x] 7.4 运行 noj-tests E2E（模板、导入、提交评测、双容器用例）确认全链路无回归

## 8. 文档

- [x] 8.1 `AGENTS.md` §1.3 与 `noj-judge/CLAUDE.md`：JudgeTask 示例移除 `solution.entry`，注明 Solution 入口为 judge 硬编码 `main.py`
- [x] 8.2 `noj-docs/docs/problemsetters/support-package.md`：参考实现段落改写为 `template` 字段索引说明（默认值、兼容性）；移除 entry 说明
- [x] 8.3 `data/problems-src/1001/statement.md`：移除"参考实现见 submission_sample.py"引用
- [x] 8.4 `openspec/specs/problem-bundle-import/` 与 `problem-runtime-config/` 主规范 sync（经 /opsx:archive 流程）
