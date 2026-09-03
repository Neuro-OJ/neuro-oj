# Agent Note: 顶层 problems/ 拆分至独立 noj-problems/ 仓库

Status: implemented

## Problem

顶层 `problems/trial-snowy-manor/` 包含完整法庭推理题支持包：剧本、状态机、参考 Agent、评测入口与测试。题目数据（含可能涉及版权或不应公开的内容）直接放在 noj 主仓库中，随主仓库分发/泄露风险高。同时主仓库已有 `noj-core/data/problems-src/` 作为内置 E2E 样例题源，二者职责需要区分。

## Decision

- 将顶层 `problems/` 从 noj 主仓库中移除：主仓库不再跟踪 `problems/`，并在根 `.gitignore` 增加 `/problems/`。
- 新建独立仓库 `noj-problems/`，保存在主仓库根目录（个人工作流便利），并在主仓库根 `.gitignore` 增加 `/noj-problems/`，使主仓库完全不感知该嵌套仓库。
- `noj-problems/` 使用 colocated jj/git 仓库；已提交初始变更 `feat(problems): 初始化 noj-problems 独立仓库并迁移 trial-snowy-manor`，git `main` 指向该提交。
- 迁移内容为 `problems/trial-snowy-manor/` 的最新工作区（含此前未提交的 8 个文件修改），排除 `__pycache__/` 与 `dist/`；`noj-problems/trial-snowy-manor/` 内 19 个单测全部通过。
- 修正独立仓库 README 中路径引用：`cd problems/trial-snowy-manor` → `cd trial-snowy-manor`。
- `noj-core/data/problems-src/` 本次不迁移：它被 `noj-core` 的 `problems:build` / `dev-setup` 与 E2E CI 实际消费，仍留在主仓库作为内置样例题源。后续如需拆分另行决策。
- 本次只做“停止跟踪 + gitignore”，不重写 git/jj 历史；历史中残留的 `problems/` 内容由后续单独指导清除。

## Alternatives considered

- 继续把题目源码放在主仓库 `problems/`：部署/CI 简单，但题目数据会随主仓库暴露，不满足隔离与防泄露目标。
- 使用 git submodule 在 `noj-core/data/problems-src/` 与 `problems/` 挂载 `noj-problems`：jj 尚未原生支持 submodule（官方 roadmap 仍为 open，社区仅提供 hacky 方案），会让 jj 工作流别扭；且当前主仓库没有代码/CI 必须实时引用 `noj-problems`，收益不足。
- 放在主仓库外兄弟目录：隔离更彻底，但不符合“放在主仓库根目录方便个人工作流”的偏好。
- 同时拆分 `noj-core/data/problems-src/`：需要改造 `problems:build`/CI 从外部拉取题目源，超出本期范围；已明确后续再议。

## Consequences

- 主仓库未来提交不再包含顶层 `problems/` 与 `noj-problems/`；`.gitignore` 已覆盖，避免误加。
- 题目支持包在独立 `noj-problems/` 仓库维护，可独立运行测试：`cd noj-problems/trial-snowy-manor && PYTHONPATH=. python3 -m unittest discover -s tests -v`。
- 由于未重写历史，主仓库旧提交中仍可查到 `problems/` 内容；需要防泄露时必须另行执行历史清理与 force push。
- `noj-core/data/problems-src/1001` 等内置样例题仍留在主仓库，`problems:build` / E2E CI 不受影响。
- 后续若需把 `noj-problems` 推送到私有远端，只需在该独立仓库内配置 remote 并推送 `main`。
