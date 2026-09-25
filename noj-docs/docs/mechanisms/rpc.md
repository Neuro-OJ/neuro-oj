# RPC 与可传递数据

> 一句话：Evaluator 与 Solution 之间用 **NDJSON 帧**（每行一个 JSON 对象）经 Judge Worker 双向转发；出题人通常只需用 `SolutionRunner`，理解线格式则有助于设计题目、解释错误与避开不可传递的数据。

## 协议角色

当前双容器使用 **NDJSON 帧**在 Evaluator、Judge Worker、Solution Host 之间转发。

```text
Evaluator SDK
  |
  | NDJSON 帧写到 evaluator stdout
  v
Judge Worker
  |
  | 帧写入 Solution Host stdin
  v
Solution Host
  |
  | 响应帧写到 Solution Host stdout
  v
Judge Worker
  |
  | 响应帧写回 evaluator stdin
  v
Evaluator SDK
```

::: info 三个通道各司其职
- Evaluator 的 **stdout** 同时承载协议帧、`---RESULT---` 标记和普通输出；Judge Worker 解析带 `type` 字段的 NDJSON 对象作为协议帧，其余文本作为评测输出。
- Evaluator 的 **stderr** 不承载 RPC 帧，只作为普通日志/诊断输出。
- Solution Host 的 **stdout** 是协议通道；Solution 用户代码若直接向 stdout `print()`，该文本不是合法协议帧，会被 Judge Worker 丢弃，不会作为评测输出展示。
:::

## 调用请求

Evaluator SDK 调用：

```python
runner.call("solve", 1, 2)
```

会生成类似下面的 NDJSON 帧：

```json
{"type":"call","id":"<uuid>","fn":"solve","args":[1,2]}
```

字段含义：

| 字段 | 必填 | 含义 |
| --- | :---: | --- |
| `type` | ✅ | 帧类型，取值范围见下文「帧类型一览」 |
| `id` | ✅ | 单次调用 ID，用于匹配响应 |
| `fn` | ✅ | 要调用的用户函数名 |
| `args` | ✅ | 编码后的定位参数列表 |
| `timeout_ms` | | **可选**。正整数 = 本次调用超时（毫秒），仅由 Judge Worker 计时；缺省/非法时回退题目级 `runtime_config.solution.call_timeout_ms` |

### cap_reg 帧（capability 默认超时上报）

Evaluator 在 `register_capability(name, handler, timeout_ms=...)` 时向 stdout 写一次性 `cap_reg` 帧：

```json
{"type":"cap_reg","name":"request_llm_completion","timeout_ms":10000}
```

- `timeout_ms` 缺省表示删除映射（该 capability 回退题目级 `call_timeout_ms`）。
- `cap_reg` 是 Evaluator → Judge 的私有协议帧，Judge 不转发给 Solution Host。
- 重复注册同名 capability：最近一次生效。

## 成功响应

Solution Host 成功返回时，写出：

```json
{"type":"result","id":"<uuid>","value":3}
```

Evaluator SDK 会解码 `value` 并作为 `runner.call()` 的返回值。

## 错误响应

调用失败时，Solution Host 或 Judge Worker 返回：

```json
{"type":"error","id":"<uuid>","code":"NotFound","message":"function 'solve' not registered"}
```

Evaluator SDK 会把它转换成对应异常：

| code | Evaluator SDK 异常 |
| --- | --- |
| `NotFound` | `NotFoundError` |
| `Rejected` | `RejectedError` |
| `CallTimeout` | `SolutionTimeoutError` |
| `Exception` / `SystemError` 等 | `SystemError` |
| 通道关闭 / host 退出 | `ConnectionError` |

::: warning 函数不存在统一为 `NotFound`
当前实现中没有 `FunctionNotFound`、`NotCallable`、`InvalidFunctionName`、`InvalidJson`、`UnknownMethod`、`HostWriteFailed`、`InvalidHostResponse`、`RestartFailed`、`InvalidRpcFrame` 这些旧错误码；函数不存在统一为 `NotFound`。
:::

## 帧类型一览

Evaluator 与 Solution 使用同一组 `type` 值（源码常量见 `noj-judge/src/dual/protocol.rs`）：

| `type` | 方向 | 含义 |
| --- | --- | --- |
| `ready` | Solution → Judge | host 启动完成（就绪前其余 Solution 帧被忽略） |
| `call` | Evaluator → Solution | 调用用户函数 |
| `result` | 双向 | 调用/capability 的成功返回值 |
| `error` | 双向 | 调用/capability 失败，或 Judge Worker 写入的调用超时 |
| `capability` | Solution → Evaluator | 请求调用 evaluator 注册的 capability |
| `cap_reg` | Evaluator → Judge | capability 默认超时上报（**不转发**） |
| `log` | Solution → Evaluator | 日志帧（judge 转发给 Evaluator 并收集；Evaluator 侧的 log 帧不转发） |
| `shutdown` | （保留）发往 host / evaluator | 关闭通知；Solution→Evaluator 方向会被识别并转发，Evaluator→host 方向按"未知帧"记 `warn` 丢弃；当前编排循环**不发送**，靠 stdin EOF 兜底 |

## 可传递的数据类型

Neuro OJ RPC 使用 JSON 加一层 Neuro OJ codec。当前支持：

| Python 类型 | 传递语义 |
| --- | --- |
| `None` | 原样传递为 JSON `null` |
| `bool` | 原样传递 |
| `int` | 原样传递 |
| `float` | 原样传递；**建议只用有限浮点数**（`NaN`/`Infinity` 行为未定义，见下） |
| `str` | 原样传递 |
| `bytes` | 编码为 `{"__bytes__": "<base64>"}` 包装对象 |
| `list` | 递归编码元素 |
| `dict` | 递归编码值，但 key 必须是字符串 |

`bytes` 的编码对象形如：

```json
{
  "__bytes__": "SGVsbG8="
}
```

::: danger 不在支持契约内的数据
以下内容**不属于** RPC 支持契约，不要传递或返回：

- `NaN`、`Infinity`、`-Infinity` 等非有限浮点数（codec 类型白名单不单独拦截，但它们无法安全序列化为严格 JSON，行为未定义）。
- key 不是字符串的字典。
- 函数、类、模块、文件句柄、生成器、迭代器。
- 自定义对象实例、异常对象本身。
:::

### 行为

- **Evaluator 传参**：`runner.call()` 在发出帧前递归校验参数类型，遇到不允许的类型立即抛 `RejectedError`；RPC 帧不会发出。
- **Solution 返回值**：Solution Host 序列化失败时返回 `code="Rejected"` 的错误帧，Evaluator 侧收到 `RejectedError`。
- **单帧大小**：超过 1 MiB 软上限会被拒绝。
- 出题人可用 `try/except RejectedError` 把这类调用按失败用例处理；不捕获则 `evaluate.py` 异常退出，该次评测落为 `error`。

## 输出与截断

::: details 输出上限与缓冲区细节
- Judge Worker 只收集 **Evaluator** 的 stdout / stderr；两者**各自**累计上限 1 MiB。超限时丢弃**头部**、保留尾部（诊断信息优先），并不额外追加截断提示。
- Solution 的输出不被收集——只有合法协议帧会被转发，其余文本直接丢弃。
- 协议行解析缓冲区为 4 MiB（用于跨 chunk 拼接单行），但**不**等同于最终收集的输出上限。
- 调用失败时，错误帧只携带 `message` 和（部分场景）清洗后的 `trace`，不会自动附加完整 stderr。
:::