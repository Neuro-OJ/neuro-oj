# Agent Note: 新增提示词题提交模式（submission_mode = prompt）

Status: implemented

## Problem

Prompt 工程类题目（LMCC 第二轮常见的"考生提供 Prompt，评测器调用 LLM 评分"）此前只能做成代码题：
在 `template.py` 里放一个 `PROMPT` 字符串让选手修改。选手需要理解 Python 语法、处理字符串转义，
提交记录里看到的也是代码而非提示词本身；同时选手仍可在 Solution 容器执行任意代码，攻击面偏大。

## Decision

- `problems.submission_mode` 新增取值 `prompt`（迁移 0096 只替换 CHECK 约束，无数据回填）；
  noj-cli vendor 副本同步放开。
- 提交语言固定为 `prompt`，`submissions.code` 保存**提示词原文**，`file_name` 固定 `prompt.md`。
  `assertSubmissionLanguage` 在正式提交与自测两处校验：prompt 题只收 `prompt`，代码题拒收 `prompt`。
- 包装集中在 `buildJudgeTask`（JudgeTask 的唯一构造入口）：`language = prompt` 时生成固定 Python
  模块（`PROMPT` 常量 + `get_prompt()`），wire 上为 `python3` / `main.py`。正式提交、自测、重测、
  sweeper 补投全部经过此入口，**judge 无需任何改动**。
- 提示词以 UTF-8 → Base64 嵌入模块，杜绝引号/三引号/反斜杠破坏字面量导致的代码注入；
  孤立代理项由 `TextEncoder` 替换为 U+FFFD，保证 Python 侧解码必然成功。
- noj-ui 新增专用的 `components/prompt/PromptWorkspace.vue`，`pages/editor/[id].vue` 按
  `submission_mode` 选择它而非代码工作区（复用同一套竞赛权限、提交/自测/历史 props）：左侧题面、
  右侧纯文本提示词编辑区 + 评测结果面板；草稿自动保存、恢复初稿、`Ctrl/⌘+Enter` 自测。
  题面中以行内代码声明的占位符（`` `{text}` ``）会被列出并标记已用/缺失，点击插入到光标处
  （`utils/promptPlaceholders.ts`）。题目页入口文案改为「编写提示词」。
- **运行历史与回滚**：每轮提交/自测的提示词本就随记录落库（`submissions.code` / `self_tests.code`），
  不新增存储。core 新增 `GET /api/v1/problems/:id/self-tests`（仅本人、不含代码，访问口径同创建自测，
  无权/保密题 404）；前端合并提交与自测为「运行历史」，按需拉取详情中的提示词做行级 diff 预览
  （LCS，`diffLines`）与一键回滚。回滚保留前一版本供「撤销回滚」，回滚后一旦继续编辑即失效，
  避免撤销覆盖新输入。
- 出题文档新增 `noj-docs/docs/problemsetters/prompt-problem.md`，约定 evaluator 通过
  `runner.call("get_prompt")` 取回提示词。

## Alternatives considered

- **只出一道"改 PROMPT 字符串"的样例题**：不改平台，但选手体验与安全边界都不改善。
- **judge 新增 prompt 分支，直接把提示词作为环境变量/文件注入 Evaluator**：语义更直接，但要改
  Rust 编排、JudgeTask 契约与双端契约快照，且绕过 Solution 容器会打破"评测对象在独立容器"的统一模型。
- **在 Python 源码中用 `repr`/JSON 字面量嵌入**：依赖两种语言转义规则完全一致，孤立代理项等边界
  情况会在 Solution 侧编码失败；Base64 更稳妥。
- **复用代码工作区（Monaco + 语言下拉固定为「提示词」）**：首版即如此实现，但 IDE 式界面
  对只写自然语言的选手干扰大（行号、语言下拉、主题切换等无意义），改为专用界面。
- **前端 localStorage 保存每轮版本**：实现最简单，但换设备/清缓存即丢失，且与服务端记录重复；
  服务端已有每轮原文，只缺自测列表接口。
- **结构化多段提示词（system/user 多字段表单）**：首版保持单段文本，分段规则由出题人在题面约定，
  后续如有需求再扩展为 JSON 结构。

## Consequences

- 题包 `problem.json` 可声明 `"submission_mode": "prompt"`，`template` 指向提示词初稿（如 `template.md`）。
- 提示词同样受 100KB `MAX_CODE_LENGTH` 约束；包装后体积约为 UTF-8 字节数的 4/3，远低于 MQ 16MB 上限。
- 若题目从 prompt 改回 code，历史 `language = prompt` 提交重测时仍按提示词包装（以提交自身语言为准）。
- LMCC VS Code 插件仍只列出 `code` 题，提示词题需在网页端作答。
