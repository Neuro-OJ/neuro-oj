# Agent Note: prediction 提交并入题目版本管理与评测调度

Status: implemented

## Problem

#572（prediction 提交）基于版本管理（#622）与 judge 调度/OI 重构合入前的 `main` 开发。合并 `main`
后：迁移 `0087` 撞号；prediction 提交服务直接读 `problems` 投影、不绑定提交时版本、不创建评测尝试；
重测/恢复路径改由版本任务驱动；judge 的 `dual/mod.rs` 已被拆分，注入原语、`build_judge_result`
（强制整数评分）、实例标签、`runtime_config` 枚举均已变化。同时评审指出三处缺陷：启动期预算被注入耗时吃掉、
候选 payload 仅保留前 8 行、上传后镜像校验失败遗留孤儿文件。

## Decision

- **迁移**：删除 PR 的 `0087`，在 `main` 链尾新增 `0113`（`problems_submission_mode_check` 扩为三值），
  由 `deno task db:generate` 生成。
- **core**：prediction 与 artifact 共用 `createUploadedSubmission`（`UploadedSubmissionSpec`
  描述文件名/魔数校验、存储扩展名、solution 是否必需）。因此 prediction 自动获得提交时版本绑定、评测尝试、
  上传补偿、保留到提交删除、可经版本任务重测。`submission_mode` 贯穿 `prepareJudgeTask`、
  批任务派发、pending 恢复；发布内容校验、执行前预检、`content-security` 对 prediction 省略 solution。
  路由按题目 `submission_mode` 分派（竞赛路由复用成员校验已取得的模式）。
- **judge**：`RuntimeConfig.solution` 为 `Option`；`dual::clamp_runtime_config`/`validate_runtime_config`
  兼容无 solution；`prediction::evaluate_prediction` 经 `build_judge_result` 取得与双容器一致的评分校验
  （非整数评分 = 平台错误，不再四舍五入）；容器 tmpfs 保留 `noexec,nosuid,nodev`，workspace 大小可参数化；
  调度内存预留对无 solution 的任务只计 Evaluator。
- **评审修复**：注入预算与 evaluator 运行预算脱钩，且不再要求 evaluator 在 30s 内有首条输出；
  含 `score` 的合法 JSON 不受普通候选名额限制；镜像校验已前移到上传之前（共享流程），不再产生孤儿对象。
- **文档**：prediction 文件生命周期改为“与产物一致，保留到提交删除，可重测”。

## Alternatives considered

- 保留 PR 原有独立 prediction 服务：需要在其中重复实现版本绑定/尝试/补偿，且与 artifact 漂移。
- 令 `submission_mode` 在 `BuildJudgeTaskInput` 中可选：会让新增构造点悄悄漏填，故保持必填。
- 保留 PR 对浮点 score 的四舍五入：与 main 的 defect #29（非整数评分是平台错误）冲突，采用后者。

## Consequences

- PR 中针对旧机制的测试（竞赛路由分派、重测/恢复固定 code）随机制移除；分派行为由 E2E 与服务层测试覆盖，
  竞赛路由分派的单元测试待补。
- prediction 题的自测不支持（无 Solution 容器）。
- 已发布版本的 `submission_mode` 不可变，因此重测/升级/恢复按目标版本内容决定任务模式。
