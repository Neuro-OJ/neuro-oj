# Evaluator SDK

Evaluator SDK 运行在 Evaluator 容器中，用于调用用户解答并输出评测结果。

## 导入

```python
from noj_evaluator_sdk import SolutionCallError, SolutionRunner, result
```

## 调用用户函数

创建 runner：

```python
runner = SolutionRunner()
```

调用用户函数：

```python
answer = runner.call("solve", 1, 2)
```

`runner.call()` 会向 Solution Host 发起一次 RPC 调用。如果调用成功，返回用户函数的返回值。

调用参数会经过 NOJ codec 编码后通过 RPC 传递。支持的类型和限制见 [RPC 与可传递数据](rpc.md)。

## 处理调用错误

如果函数不存在、函数不可调用、用户代码抛异常或 RPC 通道异常，`runner.call()` 会抛出 `SolutionCallError`。

```python
try:
    answer = runner.call("solve", 1, 2)
except SolutionCallError as exc:
    error = exc.error
```

`exc.error` 是结构化错误对象，通常包含：

- `type`：错误类型，例如 `FunctionNotFound`。
- `message`：错误消息。
- `traceback`：可选，截断后的 traceback。
- `stderr`：可选，Solution stderr 的尾部片段，用于调试用户输出或异常前日志。

常见错误类型：

| 类型 | 含义 |
| --- | --- |
| `FunctionNotFound` | 目标函数不存在 |
| `NotCallable` | 同名对象存在，但不可调用 |
| `InvalidFunctionName` | 函数名不是非空字符串 |
| 用户异常类名 | 用户函数执行时抛出了该异常 |
| `CallTimeout` | 单次调用超过 `call_timeout_ms` |
| `InvalidRpcResponse` | Judge Worker 返回给 evaluator 的响应不是合法 JSON |
| `RpcChannelClosed` | evaluator 无法继续从 Judge Worker 读取 RPC 响应 |

## 输出评测结果

Evaluator 使用 `result` 模块输出最终结果。

```python
result.accept(score=1000, details={"passed": 10})
result.wrong_answer(score=500, details={"passed": 5})
result.runtime_error(score=0, message="用户代码运行错误")
result.system_error(message="评测脚本配置错误")
```

分数是整数，当前样例题使用“实际分数乘以 100”的方式。例如满分 10 分时，`1000` 表示 10.00 分。

## details

`details` 会作为结构化结果透传给前端。建议内容稳定、可序列化，并注意不要泄露隐藏测试数据。

常见结构：

```python
details = {
    "visible": {
        "passed": 3,
        "total": 3,
        "cases": [],
    },
    "hidden": {
        "passed": 7,
        "total": 10,
    },
}
```

## restart

`runner.restart()` 会请求重启 Solution Host。首版文档只建议在确有隔离状态需求时使用；普通题目优先让 evaluator 设计成可重复调用同一个用户模块。

重启后，用户模块会重新导入，全局变量状态会重置。重启失败时会抛出 `SolutionCallError`。
