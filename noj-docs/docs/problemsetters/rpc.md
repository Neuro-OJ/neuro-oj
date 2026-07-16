# RPC 与可传递数据

本页说明 Evaluator 与 Solution 之间的调用协议语义。出题人通常只需要使用 `SolutionRunner`，不需要手写协议帧；但理解协议有助于设计题目、解释错误和避免传递不支持的数据。

## 协议角色

```text
Evaluator SDK
  |
  | __NOJ_RPC__{...} 写到 evaluator stderr
  v
Judge Worker
  |
  | JSON 请求写入 Solution Host stdin
  v
Solution Host
  |
  | JSON 响应写到 Solution Host stdout
  v
Judge Worker
  |
  | JSON 响应写回 evaluator stdin
  v
Evaluator SDK
```

Evaluator stderr 中只有带 `__NOJ_RPC__` 前缀的行会被当作 RPC 帧。其他 stderr 内容会作为普通评测输出保留。

Solution Host 的 stdout 是协议通道。用户代码的 stdout 会被重定向到 stderr，避免用户 `print()` 破坏协议。

## 调用请求

Evaluator SDK 调用：

```python
runner.call("solve", 1, 2)
```

会生成概念上类似的请求：

```json
{
  "id": "uuid",
  "method": "call",
  "name": "solve",
  "args": [1, 2],
  "kwargs": {}
}
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `id` | 单次调用 ID，用于匹配响应 |
| `method` | 当前支持 `call` 和 `restart` |
| `name` | 要调用的用户函数名 |
| `args` | 编码后的定位参数列表 |
| `kwargs` | 编码后的关键字参数字典 |

## 成功响应

用户函数成功返回时，Solution Host 返回：

```json
{
  "id": "uuid",
  "ok": true,
  "result": 3
}
```

Evaluator SDK 会解码 `result` 并作为 `runner.call()` 的返回值。

## 错误响应

调用失败时，Solution Host 或 Judge Worker 返回：

```json
{
  "id": "uuid",
  "ok": false,
  "error": {
    "type": "FunctionNotFound",
    "message": "solve"
  }
}
```

Evaluator SDK 会抛出 `SolutionCallError`，错误对象可通过 `exc.error` 读取。

错误对象常见字段：

| 字段 | 含义 |
| --- | --- |
| `type` | 错误类型 |
| `message` | 错误消息 |
| `traceback` | 用户异常 traceback，可能被截断 |
| `stderr` | Solution stderr 尾部片段，最多约 2000 字符 |

常见错误来源：

| 类型 | 来源 | 含义 |
| --- | --- | --- |
| `FunctionNotFound` | Solution Host | 用户模块中不存在目标函数 |
| `NotCallable` | Solution Host | 同名对象存在，但不可调用 |
| `InvalidFunctionName` | Solution Host | 函数名为空或不是字符串 |
| 用户异常类名 | Solution Host | 用户函数执行时抛出异常 |
| `InvalidJson` | Solution Host | Host 收到的请求不是合法 JSON |
| `UnknownMethod` | Solution Host | 请求方法未知 |
| `CallTimeout` | Judge Worker | 单次调用超过 solution `call_timeout_ms` |
| `HostWriteFailed` | Judge Worker | 无法向 Solution Host 写入请求 |
| `InvalidHostResponse` | Judge Worker | Host 响应不是合法 JSON |
| `RestartFailed` | Judge Worker | 重启 Solution Host 失败 |
| `InvalidRpcFrame` | Judge Worker | evaluator 发出的 RPC 帧不是合法 JSON |

## restart 请求

`runner.restart()` 会请求重启 Solution Host：

```json
{
  "id": "uuid",
  "method": "restart"
}
```

重启成功后，用户模块会重新导入，全局状态被清空。普通题目通常不需要重启；只有当你明确希望隔离多轮调用状态时才使用。

## 可传递的数据类型

NOJ RPC 使用 JSON 加一层 NOJ codec。当前支持：

| Python 类型 | 传递语义 |
| --- | --- |
| `None` | 原样传递为 JSON `null` |
| `bool` | 原样传递 |
| `int` | 原样传递 |
| `float` | 仅支持有限浮点数 |
| `str` | 原样传递 |
| `bytes` | 编码为 base64 包装对象 |
| `list` | 递归编码元素 |
| `tuple` | 编码为列表，返回后不保留 tuple 类型 |
| `dict` | 递归编码值，但 key 必须是字符串 |

`bytes` 的编码形式：

```json
{
  "__noj_type__": "bytes",
  "base64": "SGVsbG8="
}
```

## 不支持的数据

以下内容不能直接通过 `runner.call()` 传递或返回：

- `NaN`、`Infinity`、`-Infinity` 等非有限浮点数。
- key 不是字符串的字典。
- 函数、类、模块、文件句柄、生成器、迭代器。
- 自定义对象实例。
- 异常对象本身。

如果题目需要复杂结构，建议转换成由 `dict[str, ...]`、`list`、数字、字符串和字节串组成的数据结构。

## 传递数据的设计建议

- 只把用户求解所需的输入传给 Solution，不要传隐藏答案。
- 大型静态数据应放在支持包中由 Evaluator 读取，再传递必要片段给 Solution。
- 返回值应尽量稳定、可 JSON 化，便于 evaluator 比较和写入 `details`。
- 对浮点题目，应在 evaluator 中定义误差容忍，而不是要求用户返回字符串。
- 不要把 RPC 当作文件传输通道；大量数据会增加序列化和日志成本。

## 输出与截断

Judge Worker 会限制收集到的容器输出大小。当前单个输出缓冲最多约 4 MiB，超过后会追加截断提示。

当调用失败时，Judge Worker 会把 Solution stderr 的尾部片段附加到错误对象中，帮助 evaluator 记录调试信息。出题人应避免把完整 stderr 原样暴露给所有用户，尤其是隐藏测试场景。
