# 结果状态

结果状态（verdict）是一次提交的最终判定。新协议下最终状态只保留 `finished`（已评测）和 `error`（出错），**分数是唯一结果**；`Accepted` / `WrongAnswer` 等不再作为最终判定，仅可作为 `details.cases` 中的用例级参考信息。术语定义见[术语表](glossary.md)。

## finished

评测完成，evaluator 已给出分数。分数可以是满分、部分分或 0 分；AI/LLM 等连续评分题目通常没有“满分通过”的二分语义，因此以分数为准。

## error

评测未正常完成，通常由评测环境、支持包、镜像、超时或 evaluator 自身异常导致。`error` 状态不展示有效分数。

## 用例级状态（details.cases）

`details.cases` 中的每个用例可以携带 `status` 作为参考信息，例如 `Accepted` / `WrongAnswer` / `RuntimeError` / `TimeLimitExceeded`。这些是**用例级**状态，不是提交的最终判定；最终判定只由 `finished` / `error` + 分数表达。

## 超时与系统错误

- **单次调用超时**（`call_timeout_ms`）：用户函数单次调用超过调用级超时。Judge Worker 向 evaluator 注入 `CallTimeout` 错误；若 evaluator 未捕获（evaluate.py 异常退出、无 `---RESULT---`），最终状态为 `error`。若 evaluator 捕获并记为失败用例，最终状态由 evaluator 决定（通常为 `finished` + 0 分）。
- **整体流程超时**（`time_limit_ms`）：evaluator 整体执行超过时限，由 Judge Worker 强制终止评测，最终状态为 `error`。
- **系统错误**：评测环境、纯净评测包、镜像、协议、运行时配置或 evaluator 自身存在问题，最终状态为 `error`。

做题人遇到 `error` 时，一般不应通过修改答案逻辑解决，而应联系运营者或出题人排查。
