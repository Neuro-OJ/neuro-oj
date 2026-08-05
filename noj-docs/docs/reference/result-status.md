# 结果状态

结果状态（verdict）是一次提交的最终判定，由题目 evaluator 决定。术语定义见[术语表](glossary.md)。

## Accepted

题目 evaluator 判定提交通过。是否满分由该题的评分逻辑决定；通常 Accepted 表示达到题目定义的通过条件。

## WrongAnswer

用户代码没有满足题目 evaluator 的通过条件。部分分题可以在 WrongAnswer 状态下返回非零分。

在 Neuro OJ 的函数调用型评测中，`WrongAnswer` 的语义比传统 OJ 更宽：

- 返回值、格式或评分结果不满足要求，会是 `WrongAnswer`。
- 用户函数抛异常后，如果 evaluator 把该次调用按失败用例处理，最终也可能是 `WrongAnswer`。
- 调用阶段的超时或资源异常，如果 evaluator 选择把它记为普通失败而不是直接中断整场评测，最终同样可能落成 `WrongAnswer`。

## TimeLimitExceeded

提交超过时间限制。超时来源分两类：

- **单次调用超时**（`call_timeout_ms`）：用户函数单次调用超过调用级超时。Judge Worker 向 evaluator 注入 `CallTimeout` 错误；若 evaluator 未捕获（evaluate.py 异常退出、无 `---RESULT---`），最终状态为 `TimeLimitExceeded`。若 evaluator 捕获并记为失败用例，最终状态由 evaluator 决定（如 `WrongAnswer`）。
- **整体流程超时**（`time_limit_ms`）：evaluator 整体执行超过时限，由 Judge Worker 强制终止评测，最终状态为 `SystemError`（见下），**不会**落成 `TimeLimitExceeded`。

## MemoryLimitExceeded

提交超过内存限制。限制由运行时配置和 Judge Worker 执行环境控制。

## RuntimeError

运行时错误。通常表示 evaluator 显式把某类用户失败映射成运行时错误，或者评测逻辑把该错误视为不可继续评分的用户侧异常。

## SystemError

系统错误。通常表示评测环境、纯净评测包、镜像、协议、运行时配置或 evaluator 自身存在问题。

在当前双容器 Python 模型下，下面这些情况通常更容易得到 `SystemError`：

- Solution Host 无法启动。
- 用户代码语法错误，导致模块无法导入。
- 纯净评测包缺失 `evaluate.py` 或 evaluator 自身崩溃。
- 运行时镜像不存在或白名单配置错误。
- evaluator 整体执行超过 `time_limit_ms`（Judge Worker 强制终止）。
- evaluator 启动超时（评测环境未就绪）。

做题人遇到 SystemError 时，一般不应通过修改答案逻辑解决，而应联系运营者或出题人排查。
