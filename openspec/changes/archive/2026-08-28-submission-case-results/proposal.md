## Why

提交结果页目前只展示总状态、分数和原始评测输出。当部分测试点失败时，用户必须手动阅读评测日志，难以快速定位问题。评测结果协议已经预留结构化 `details.cases`，现在需要统一字段并把它真正展示出来。

## What Changes

- 为评测测试点统一使用 `case_id`、`status`、`time_ms`、`expected_output`、`actual_output` 等标准字段。
- 样例评测器记录每个测试点的运行耗时，并输出标准字段。
- 在提交结果页增加测试点汇总和明细，展示通过状态、耗时、期望输出与实际输出。
- 对缺失、格式异常或旧字段的测试点详情安全降级，不影响总结果展示。
- 隐藏测试点不向非授权访问者泄露输入、期望输出或评测细节。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `openspec/specs/redis-message-queue`: 明确结构化测试点结果的标准字段、耗时记录和敏感字段可见性。
- `openspec/specs/submission-history-page`: 扩展提交详情页，展示测试点状态、耗时、期望输出和实际输出。

## Impact

- `noj-core/data/problems-src/1001/evaluate.py`：输出标准化测试点详情。
- `noj-core/src/types/index.ts` 与提交详情 DTO：补充可复用的测试点结果类型。
- `noj-ui/pages/submissions/[id].vue` 及新增提交详情组件：渲染测试点汇总和明细。
- `noj-core/tests`、`noj-tests` 和前端静态/类型检查：增加契约与渲染回归覆盖。
- 不新增数据库字段，不改变提交详情接口路径；仅扩展已有 `result.details` 内容。
