# 理解结果

提交后，NOJ 会经历排队、评测和结果回传几个阶段。

## 队列状态

提交刚创建时可能处于等待状态。系统会通过 Redis 消息队列把任务分发给 Judge Worker。

## 评测中

Judge Worker 收到任务后会下载支持包、校验 checksum、注入用户代码，并在 Docker 容器中执行评测。

## 最终状态

常见状态见[结果状态参考](../reference/result-status.md)。其中：

- `Accepted` 表示题目 evaluator 判定通过。
- `WrongAnswer` 表示没有满足该题的评分条件。对函数调用型题目来说，返回值错误、函数抛异常，甚至某些被 evaluator 当作失败样例处理的超时或资源异常，都可能显示为 `WrongAnswer`。
- `RuntimeError` 表示评测逻辑把这次失败明确归类为运行时错误。
- `TimeLimitExceeded` 表示评测流程本身被直接判定为超时。
- `SystemError` 表示评测环境或题目配置异常，通常需要运营者排查。

如果你看到 `SystemError`，常见原因包括题目配置错误、运行时镜像缺失、支持包损坏，或者代码连模块都没法被评测端导入。这个状态通常不是简单改答案逻辑就能解决的。

## 分数与详情

NOJ 的分数由题目 evaluator 给出。部分题目会返回可见用例、隐藏用例、格式分、内容分或其他结构化详情。隐藏用例的输入和答案是否展示由题目 evaluator 控制。
