# Evaluator SDK

Evaluator SDK 运行在 Evaluator 容器中，用于调用用户解答并输出评测结果。

## 导入

```python
from noj_evaluator_sdk import (
    SolutionRunner,
    NotFoundError,
    RejectedError,
    SolutionTimeoutError,
    SystemError,
    ConnectionError,
    result,
)
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

**调用级超时**：`runner.call()` 支持可选 `timeout_ms` 参数，每次调用可指定独立超时（毫秒）。缺省（`None`）时由 Judge Worker 回退到题目的 `runtime_config.solution.call_timeout_ms`：

```python
answer = runner.call("solve", 1, 2)                    # 用题目级默认超时
answer = runner.call("solve", 1, 2, timeout_ms=5000)   # 本次调用 5s 超时
```

`timeout_ms` 必须为正整数或 `None`，其他值（0 / 负数 / 非整数）抛出 `ValueError`。超时后 `runner.call()` 抛出 `SolutionTimeoutError`，可捕获后记为失败用例继续评测。

调用参数会经过 Neuro OJ codec 编码后通过 RPC 传递。支持的类型和限制见 [RPC 与可传递数据](rpc.md)。

## 处理调用错误

`runner.call()` 会根据错误类型抛出以下异常：

| 异常 | 含义 |
| --- | --- |
| `NotFoundError` | 目标函数不存在 |
| `RejectedError` | 参数/返回值类型不允许，或帧超过 1 MiB 软上限 |
| `SolutionTimeoutError` | 单次调用超过 `call_timeout_ms`。若 evaluator 未捕获（evaluate.py 异常退出、无 `---RESULT---`），最终状态为 `error` |
| `SystemError` | host 内部错误、异常执行、IPC 通道异常等不可恢复错误 |
| `ConnectionError` | Solution Host 已关闭 / IPC 通道断开 |

```python
try:
    answer = runner.call("solve", 1, 2)
except SolutionTimeoutError:
    # 超时按失败用例处理
    result.wrong_answer(score=0, message="调用超时")
except RejectedError as exc:
    # 参数/返回值类型非法
    result.wrong_answer(score=0, message=str(exc))
except NotFoundError:
    # 函数未实现
    result.wrong_answer(score=0, message="函数不存在")
```

### 参数与返回值类型校验（RejectedError）

`runner.call()` 在发出 RPC 帧之前会**递归校验参数类型**：只允许 `None / bool / int / float / str / bytes / list / dict`（dict 的 key 必须是 `str`），任何其他类型——包括嵌套在 list / dict 中的自定义对象、`set`、`tuple`、函数、生成器、文件句柄等——都会**直接抛出 `RejectedError`**，错误消息带路径与类型名：

```text
arg[0]: 不支持的类型 MyClass（仅 None/bool/int/float/str/bytes/list/dict）
```

此时 RPC 帧**不会发出**，Solution 侧完全不知情。帧序列化超过 1 MiB 软上限时同样抛出 `RejectedError`。

返回值路径对称：Solution 返回不支持类型时，Judge Worker 以 `code="Rejected"` 的错误帧返回，Evaluator 侧同样收到 `RejectedError`。

出题人可以用 `try/except RejectedError` 把这类调用按失败用例处理；不捕获则 `evaluate.py` 异常退出，该次评测落为 `error`。

## 注册 capability（供 Solution 调用）

当题目需要让 solution 使用网络等能力时，用 `register_capability` 暴露一个**精确封装**的 handler：

```python
from noj_evaluator_sdk import register_capability

def request_llm_completion(prompt: str) -> str:
    # evaluator 已联网（runtime_config.evaluator.network.enabled = true）
    # ... 调用固定 URL 的外部 API，参数校验由 handler 负责
    return completion_text

register_capability("request_llm_completion", request_llm_completion)
```

**capability 默认超时**：`register_capability(name, handler, timeout_ms=None)` 可配置 solution 每次调用该 capability 的超时（毫秒）。注册时经 `cap_reg` 帧上报 Judge，缺省（`None`）回退题目级 `call_timeout_ms`：

```python
register_capability("request_llm_completion", handler, timeout_ms=10000)
```

- Solution 通过 `noj_solution_sdk.call_capability(name, *args)` 调用；请求经 judge 转发到 evaluator，在 **runner 的 reader 线程**中同步执行 handler，结果以 `result` 帧返回。
- 返回值与 `runner.call()` 相同约束（`None / bool / int / float / str / bytes / list / dict`）；返回值类型非法或帧超限（> 1 MiB）→ `code="Rejected"`；handler 异常 → `code="Exception"`（含清洗后 trace），未注册 → `code="NotFound"`。
- **不要嵌套双向调用**：capability handler 在 reader 线程中同步执行，若 handler 内再调用 `runner.call()`（回调 solution），双方会互相等待而死锁，只能等评测总超时兜底——不支持这种嵌套。
- 重复注册同名 capability：最近一次生效。
- **安全模型**：capability 是 solution 使用网络的唯一入口，**不要注册通用 URL 转发**（如 `fetch_url(url)`）；应封装固定目标的业务函数并做参数校验。详细指南见 [如何提供受限网络能力](capability-networking.md)。

## 输出评测结果

Evaluator 使用 `result` 模块输出最终结果。

```python
result.accept(score=1000, details={"passed": 10})
result.wrong_answer(score=500, details={"passed": 5})
```

新协议下结果 JSON 不再输出 `status`，只输出 `score` 与 `details`；`accept` / `wrong_answer` 只是写入分数的便捷方法。评测脚本自身出错时应直接抛出异常或非零退出，由 judge 统一映射为 `error`；SDK 已移除 `runtime_error()` / `system_error()` 结果写入方法。

分数是整数，当前样例题使用“实际分数乘以 100”的方式。例如满分 10 分时，`1000` 表示 10.00 分。

## details

`details` 会作为结构化结果透传给前端。若需要展示测试点明细，推荐使用扁平的
`cases` 数组。每个测试点至少包含 `case_id` 和 `status`，还可以提供
`visibility`（`visible`/`hidden`）、`time_ms`、`memory_kb`、
`input`、`expected_output` 和 `actual_output`。

常见结构：

```python
details = {
    "cases": [
        {
            "case_id": "v001",
            "status": "Accepted",
            "visibility": "visible",
            "time_ms": 12,
            "expected_output": "3",
            "actual_output": "3",
        },
        {
            "case_id": "h001",
            "status": "WrongAnswer",
            "visibility": "hidden",
            "time_ms": 15,
        },
    ],
}
```

隐藏测试点可以展示状态、耗时和内存，但 MUST NOT 在 `details` 中写入输入、期望
输出或实际输出。历史的 `visible.cases`/`hidden.cases` 以及 `id`/`expected`/`actual`
字段仍可被提交结果页兼容，但新评测器应使用上述标准字段。

## 关闭 runner

`runner.close()` 可主动关闭 runner（通常不需要，进程结束自动清理）。当前 SDK **不提供** `runner.restart()`。
