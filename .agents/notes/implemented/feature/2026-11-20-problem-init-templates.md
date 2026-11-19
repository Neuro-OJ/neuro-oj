# Agent Note: problem init --template 五类可验题模板

Status: implemented

## Problem

出题人（含 AI 辅助出题）此前只能从「最小骨架」起步：骨架没有参考解答，评测脚本
是 TODO 或只覆盖代码题，预测提交题、LLM 工程题、客观题、界面题都要从文档里拼凑
约定，常见坑（分数刻度、隐藏用例泄露、选手异常被记成平台错误、LLM 调用预算）要
上线后才暴露。另外 `noj-cli problem init` 与 `noj problems init` 是刻意的两份
实现，若各自维护模板内容必然漂移。

## Decision

1. **模板事实源是真实目录**：`noj-core/scripts/problem-templates/<name>/`，五个
   模板 `code` / `prediction` / `llm` / `objective` / `ui`，每个都带 README
   （改造步骤与常见坑）、评测脚本（客观题除外）和 `submissions/`（满分解、错解、
   空解与 `expect.json`），可直接 `noj-cli problem test`，`lint --strict` 零发现。
   内容全部为合成示例，不含任何真实题库内容。
2. **嵌入而非运行时读取**：noj-cli 以 `deno compile` 单二进制分发，读不到仓库
   文件，因此由 `scripts/gen-problem-templates.ts` 把模板目录生成为无依赖的纯数据
   模块 `problem-templates.generated.ts`；`--check` 进入仓库门禁（`gate-list.ts`），
   漂移即失败。
3. **两处 init 共用渲染**：`scripts/problem-templates.ts`（只引用生成模块）提供
   `renderProblemTemplate`，`noj-cli/src/problem/init.ts` 与
   `noj-core/scripts/problems-init.ts` 以相对路径引用，模板内容只有一份；两处 init
   只负责目录保护与回滚（core 侧补了子目录创建与递归回滚）。渲染只改写
   `problem.json` 的 title / difficulty 与题面、README 首行标题。
4. **模板评测脚本的异常分类**：选手侧错误（异常、超时、缺函数、崩溃）只让该用例
   失败；评测脚本自身错误与 LLM 网关/额度错误上抛为平台错误，`problem test` 会
   因此失败，避免「脚本坏了却出 0 分」。
5. **验收门禁**：e2e.yml 的 problem-local-test 作业对五个模板逐一执行
   `init --template` → `lint --strict` → `problem test`（真实 Docker）。
6. **顺带修复**：客观题 `questions.json` 的文档示例与真实导入格式不符（文档写
   `title`、选项字典、标量答案；实际为 `prompt`、`{key, text}` 数组、数组答案），
   且 `lint` 不校验 `questions.json`。现 `lint` 复用 core 的
   `validateObjectiveQuestions`（规则 `must/questions-invalid`），两处文档已改正。

## Alternatives considered

- **两处 init 各自内联模板字符串**：维持「刻意第二份实现」的形式，但五个模板约
  50 个文件，双份维护必然漂移，否决。
- **`deno compile --include` 嵌入模板目录、运行时读取**：需要区分源码运行与编译
  运行两种路径，core 侧也无法复用，否决。
- **文本 import（`with { type: "text" }`）**：需要不稳定特性开关，否决。
- **模板中使用 `{{title}}` 占位符**：模板目录将无法直接 lint/test，否决；改为
  渲染时改写 manifest 字段与首行标题。
- **TUI 中追问模板**：会改变既有引导流程与测试，暂只提供 `--template` 旗标。

## Consequences

- 改模板只改 `noj-core/scripts/problem-templates/`，随后运行
  `deno run -A noj-core/scripts/gen-problem-templates.ts`；忘记生成会被门禁拦下。
- 新增模板需同时改 `PROBLEM_TEMPLATE_NAMES` 与说明、e2e 作业的模板列表；
  `problems-init-templates_test.ts` 断言目录与名称一一对应。
- 客观题 `lint` 变严：此前能过 lint 但导入必失败的 `questions.json` 现在本地即报错。
- 依赖 P0-2 A（`problem test` 与 run-local）。
