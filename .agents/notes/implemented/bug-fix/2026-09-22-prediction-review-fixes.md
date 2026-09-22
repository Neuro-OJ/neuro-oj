# Agent Note: prediction 提交评审修复——对齐复杂度、结果标记语义、workspace 上限与 LLM 准入

Status: implemented

## Problem

编号 #572 的 prediction 提交题（本地 GPU 出分、服务端判分）在合入前评审发现四处缺陷：

1. **SDK 对齐校验是 O(n²)**：`noj_evaluator_sdk.prediction.assert_id_alignment` 用
   `{i for i in got if got.count(i) > 1}` 判重复，逐元素 `list.count()` 使整体复杂度为
   平方级。实测 1 万行 0.6s、5 万行 15s、10 万行 67s。出题人指南要求用它校验 ID 对齐，
   而 prediction 面向的正是 Kaggle 形态的大数据集——大文件会白白吃掉评测时限甚至必然
   超时（`system_error`）。

2. **结果标记语义会把已拿到的结果清掉**：`prediction/mod.rs` 的流式解析每遇到一行
   `---RESULT---` 就重置 payload。evaluator 若调试打印过该字符串，或 stdout 块缓冲下
   进程在「写标记」与「flush payload」之间死亡（标记先行、payload 丢失），后续标记会把
   已捕获的合法 payload 清空，最终报「评测脚本未输出结果标记」。

3. **题目级 workspace_size_mb 无界**：`JUDGE_PREDICTION_WORKSPACE_MB` 在 judge 配置侧
   收敛到 512–16384，但题目级 `evaluator.workspace_size_mb` 只校验「正整数」，既不被
   `clamp_runtime_config_for_prediction` 收敛，也不在 `RESOURCE_LIMIT_SETTINGS` 中
   （管理员没有全局上限）。U 型题 owner 可写任意大值并直达 Docker `tmpfs` size。

4. **prediction 题可配置 LLM 但不生效**：题目级 `llm_config` 在 prediction 模式下仍可
   保存，编辑器也允许勾选；但 `createPredictionSubmission` 不构造 `llm`/`user_llm`，
   judge 侧 `prediction` 路径也不注入 `NOJ_LLM_*`（唯一注入点 `dual::build_llm_env`）。
   结果是评测在首次 `llm.complete(...)` 时抛出「环境变量未配置」，只有提交期才暴露。

## Decision

1. `assert_id_alignment` 改为单趟 `collections.Counter` 统计重复 ID，保留「重复 / 缺少 /
   多出 / 行数」四类报告与既有错误文案；新增线性复杂度回归测试（5 万行 < 5s 上限）。
2. 标记语义定为**首个标记生效**：payload 已捕获（非空）时忽略后续 `ResultMarker`；空
   payload（等下一非空行）时保持原语义，使「标记与 payload 跨 chunk」仍能收尾。新增
   「第二组标记不覆盖已捕获 payload」「第一组无 payload 时仍吸收第二组」两个回归测试。
3. 题目级 `workspace_size_mb` 在 judge 侧新增 `resolve_workspace_mb()`，与 worker 配置
   收敛到同一 512–16384 范围（放在 `prediction/mod.rs`，避免触碰 `dual/mod.rs` 的
   单文件规模棘轮基线）；core 侧新增 `judge_max_prediction_workspace_mb` 设置项并登记
   进 `RESOURCE_LIMIT_SETTINGS`，超限在保存期即 400。
4. **prediction 题禁止 LLM 配置**（用户决策）：创建、更新、题目包导入三条写入路径统一
   拒绝；更新路径用 `effectiveSubmissionMode` 判定，且对「已配 LLM 的题目切为
   prediction」显式 400（要求先移除 LLM，避免静默丢弃配置，同时不阻断 prediction → code
   的反向切换）。编辑器在 prediction 模式下隐藏 LLM 卡片，并省略该字段而非发 `null`
   （发 `null` 会被 update 路径当作「显式清空」，绕过上述守卫）。

## Alternatives considered

- **让 prediction 支持 LLM（照 artifact 路径补齐接线）**：需要把 `build_llm_env` 提为
  `pub(crate)` 并在 prediction 路径注入 env、复用 token 签发与额度。prediction 的评测
  语义是「确定性数据评分」，LLM 属于可选的出题人便利功能；用户明确选择不做接线，改用
  fail-fast 收紧语义。**否决（用户决策）**。
- **对「已配 LLM 的题切 prediction」静默清空 llm_config**：与「改为客观题时自动清空」
  的既有先例一致，但会让出题人的配置无声消失。**否决**，改为 400 要求显式移除。
- **把 workspace 收敛写进 `clamp_runtime_config_for_prediction`（`dual/mod.rs`）**：语义
  上更贴切，但该文件已登记 2246 行棘轮基线，任何增长即门禁失败；且收敛只对 prediction
  路径有意义。**否决**，改放在 `prediction/mod.rs` 的 `resolve_workspace_mb`。
- **保留 O(n²) 实现但在文档里警告大文件**：复杂度问题是确定性的，警告无法阻止 10 万行
  以上的提交超时。**否决**。

## Consequences

- **正面**：大预测文件的 ID 对齐从「分钟级」降到「毫秒级」；结果标记不再被噪声标记清空；
  `workspace_size_mb` 有 judge 硬范围 + 管理员可配上限两层约束；LLM 与 prediction 的
  语义冲突在保存期即暴露，不再出现「配置成功、评测才报环境变量缺失」。
- **负面**：prediction 题彻底不能使用 LLM 能力（若将来需要，需重新接线并放开三处守卫）；
  「已配 LLM → 切 prediction」需要两个请求（先清空 LLM，再切模式）。
- **中性**：新增一个 runtime 设置项 `judge_max_prediction_workspace_mb`（默认 0 =
  仅受 512–16384 硬范围约束），已登记 `.env.example` 与文档。
