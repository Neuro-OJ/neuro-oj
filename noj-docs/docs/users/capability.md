# 使用 capability

> 一句话：Solution 容器**始终无网**；题目需要联网时，由出题人在 Evaluator 注册 capability，你用 `call_capability` 调用。

某些题目（尤其是大模型应用类题目）会涉及与外部网络 API 的交互。出于安全考虑，你的代码（Solution 容器）**始终没有网络能力**——无法直接发起 `socket` / `urllib` / `requests` 等网络请求。

如果题目需要网络，出题人会在评测端（Evaluator）注册**能力（capability）**，你在函数中通过 `call_capability` 调用它，由评测端代为执行。你拿到的只是返回值，网络访问始终发生在可信的评测端。

## 前提

- 题目说明中会声明可用哪些 capability（名称、参数、返回值）。
- 未声明 capability 的题目调用 `call_capability` 会抛 `CapabilityNotFoundError`。

::: warning 调用位置
`call_capability` 必须在你的**注册函数内部**调用。模块顶层调用也能工作（Host 会先启动响应分发线程），但不受调用级超时保护，不建议这样做。
:::

## 基本用法

```python
from noj_solution_sdk import call_capability

def solve(prompt: str) -> str:
    # 调用出题人注册的 capability（参数/返回值由题面定义）
    reply = call_capability("request_llm_completion", prompt)
    return reply
```

`call_capability(name, *args)` 会**阻塞**等待评测端执行完毕并返回结果。

## 参数与返回值约束

与普通函数调用相同的 [RPC 类型约束](../mechanisms/rpc.md)：

- 只允许 `None` / `bool` / `int` / `float` / `str` / `bytes` / `list` / `dict`
- `bytes` 会自动进行 base64 编码传输
- 自定义对象、函数、文件句柄等不可序列化类型会被拒绝（抛 `CapabilityRejectedError`）
- **单帧超过 1 MiB**（含参数与返回值）会被拒绝

## 错误处理

| 异常 | 含义 |
|------|------|
| `CapabilityNotFoundError` | capability 未注册（题面未声明该能力） |
| `CapabilityRejectedError` | 参数/返回值类型不允许，或单帧超过 1 MiB |
| `CapabilityError` | 评测端执行失败；`code` 与清洗后的 `trace` 可查看 |
| `CapabilityConnectionError` | 评测端通道断开（通常意味着评测环境异常） |

```python
from noj_solution_sdk import call_capability, CapabilityNotFoundError

def solve(prompt: str) -> str:
    try:
        return call_capability("request_llm_completion", prompt)
    except CapabilityNotFoundError:
        return "该能力不可用"
```

## 示例：带网络能力的题目

题面声明 `request_llm_completion(prompt) -> str` 时：

```python
from noj_solution_sdk import call_capability

def solve(prompt: str) -> str:
    completion = call_capability("request_llm_completion", prompt)
    # 基于返回结果继续处理
    return completion.strip().upper()
```

## 注意事项

::: tip 控制调用次数与返回大小
- capability 调用受**评测总时限**约束；`call_capability` 本身没有单次超时，阻塞到评测端返回，评测总超时才会兜底终止。
- 不要在函数内做无意义的重复调用（既耗时也可能触发题目的额度限制）。
- 返回值同样受类型约束，超大返回（> 1 MiB）会被拒绝。
- capability 的具体行为（如重试、超时、访问哪些域名）由出题人定义，题面会说明。
:::
