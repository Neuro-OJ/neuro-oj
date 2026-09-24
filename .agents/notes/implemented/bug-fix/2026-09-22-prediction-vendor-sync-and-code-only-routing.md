# Agent Note: prediction 提交终审修复——vendor 副本同步与重测/恢复模式路由

Status: implemented

## Problem

本地 GPU prediction 提交（`submission_mode = "prediction"`）合入后，终审发现两个合并阻断缺陷：

1. **noj-cli vendored 副本漂移**：`noj-cli/src/problem/vendor/` 是 core 题目包校验的
   刻意字节副本（issue #514，硬规则「修改时必须同步两处」）。core 已接受
   `submission_mode: "prediction"`（`runtime_config.solution` 可选、
   `evaluator.workspace_size_mb` 可选），但 CLI 副本仍只认 `code / artifact` 且强制
   `solution`，导致出题人用 `noj-cli` 校验 prediction 题目包时被误拒。共享 fixture
   `fixtures/problem-bundle-manifest.json` 也没有 prediction 正例，两侧契约测试形同虚设。

2. **重测 / sweeper 从题目而非路径派生模式**：单条重测、批量重测与 pending 恢复这三处
   只能承载代码提交（重测显式拒绝 `artifact_storage_url` 非空；恢复查询条件为
   `artifact_storage_url IS NULL`），却发出题目当前模式。作者把既有题目从 `code`
   切成 `prediction` 后，这些旧代码提交会被误路由到 prediction 分支——任务无预测文件，
   judge 报错，表现为静默失败。

## Decision

1. 将四个 vendored 文件与 core 原文件逐字对齐（仅保留既有的 header 与相对导入风格）：
   `SUBMISSION_MODES` 增补 `prediction`；`RuntimeConfig.solution` 改为可选、
   `EvaluatorRuntime.workspace_size_mb` 增补；`validateRuntimeConfig` 增加
   `submissionMode: SubmissionMode = "code"` 参数（code/artifact 必填 solution、
   prediction 可省略、可选 `workspace_size_mb` 校验）；`problem-bundle.ts` 的非法模式
   文案更新并把 manifest 的 `submission_mode` 传入校验。同步在共享 fixture 增加一个
   prediction 正例（evaluator-only，无 solution），让两侧契约测试真正守住新语义。

2. 三处只可能承载代码提交的构造点固定发出 `submission_mode: "code"`，并以中文注释
   写明理由（不能从 `problem.submission_mode` 派生，否则模式切换后误路由）。sweeper
   保留 `source === "self_test"` 的语义分支（两支均为 `"code"`）。移除因此变为未使用的
   `JudgeSubmissionMode` 导入与 `PendingRecoveryRow.submission_mode` 字段及对应
   `selectFields` 列。

## Alternatives considered

- **让 CLI 直接导入 core 的校验实现**：与 issue #514 的既定取舍冲突（noj-cli 不依赖主
  仓库导入映射），且会把数据库服务依赖带进离线 CLI。**否决**。
- **重测/恢复按题目模式动态推导并补充预测文件**：prediction 明确不支持重测（预测文件
  评测后即删），恢复窗口内的行也必为代码提交；动态推导只会把错误放大。**否决**。
- **保留 `problem.submission_mode` 派生但加运行时兜底**：需要在三处重复「若 prediction
  则改判 code」的逻辑，且无法区分「确实的 prediction 任务」与「被误推的旧代码提交」。
  **否决**。

## Consequences

- **正面**：CLI 与 core 对 prediction 题目包行为一致；共享 fixture 契约测试覆盖第三条
  模式；重测/恢复不再受题目模式切换影响。
- **负面**：vendored 副本仍靠人工同步，本次修复降低了漂移面但不消除该结构性风险；新增
  prediction 语义后若再改 core，必须继续同步两处。
- **中性**：重测/恢复任务的 `submission_mode` 恒为 `code`，与这些路径的实际载荷一致。
