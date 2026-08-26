# 测试数据与样例规范

Neuro OJ 不强制测试数据格式。出题人可以把测试数据放在纯净评测包里，也可以在 `evaluate.py` 中动态生成输入。只要 evaluator 能完成调用、评分和结果输出即可。本文给出**推荐约定**与**质量建议**。

## 推荐 JSONL 格式

内置样例题使用 JSON Lines 作为推荐约定：每一行是一个独立 JSON 对象。

```json
{"id":"v001","input":"1 2\n","expected":3}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `id` | 稳定用例 ID，便于定位 |
| `input` | evaluator 解析的输入材料 |
| `expected` | 标准结果或评分参考 |
| `score` | 可选，该用例分值（部分分） |
| `tags` | 可选，用例分类 |
| `message` | 可选，对可见用例展示的说明 |

## 目录约定

推荐使用以下两种之一：

```text
visible.jsonl
hidden.jsonl
```

或

```text
cases/visible/*.json
cases/hidden/*.json
```

也可以使用 SQLite、CSV、YAML、纯文本或二进制资源，只要 `evaluate.py` 自己能读取。

## 可见 / 不可见语义

- **可见测试数据**：用于做题人调试展示（输入、期望、实际结果）。
- **不可见测试数据**：用于正式评分，默认不向用户展示输入/期望/细节。

### Neuro OJ 建议：全部正式评分数据使用不可见测试数据

LMCC 官方标准区分可见与不可见测试数据。Neuro OJ 采用更严格的建议：

- **正式评分**只使用不可见测试数据。
- **可见数据**仅用于题面示例与调试，不计入正式评分。

## 样例自测与调试输出

- 题面中的样例应同时作为 evaluator 的**可见自测用例**，**参与评测但不计分**。
- evaluator 应输出**对选手友好的调试信息**，且**明确易读**：结构化、标注输入/期望/实际、错误原因，方便选手定位问题。
- 调试信息**不得包含隐藏数据**。

## 避免泄露隐藏用例数据

隐藏用例的数据是否出现在结果详情中完全由 evaluator 决定。建议：

- 可见用例可以展示输入、期望和实际输出。
- 隐藏用例默认只展示用例 ID、通过状态和错误类型。
- **不要把完整隐藏输入和标准答案直接放进面向用户的 `details`**。

## 测试点结果详情（details.cases）

为了让提交详情页统一展示测试点明细，新评测器建议在最终结果的 `details` 中输出扁平的 `cases` 数组。每个测试点至少包含 `case_id` 和 `status`，推荐字段如下：

| 字段 | 说明 |
|------|------|
| `case_id` | 稳定用例 ID，与测试数据中的 `id` 对应 |
| `status` | 该用例状态，如 `Accepted` / `WrongAnswer` / `RuntimeError` / `TimeLimitExceeded` |
| `visibility` | `visible` 或 `hidden`；省略时按 `visible` 处理 |
| `time_ms` | 可选，该用例耗时（毫秒） |
| `memory_kb` | 可选，该用例内存（KB） |
| `input` | 仅可见用例可包含 |
| `expected_output` | 仅可见用例可包含 |
| `actual_output` | 仅可见用例可包含 |

示例：

```json
{
  "cases": [
    {
      "case_id": "v001",
      "status": "Accepted",
      "visibility": "visible",
      "time_ms": 12,
      "expected_output": "3",
      "actual_output": "3"
    },
    {
      "case_id": "h001",
      "status": "WrongAnswer",
      "visibility": "hidden",
      "time_ms": 15
    }
  ]
}
```

约定：

- **隐藏用例**可以展示 `case_id`、`status`、`visibility`、`time_ms`、`memory_kb`，但 MUST NOT 写入 `input`、`expected_output`、`actual_output`。
- **可见用例**可以展示输入、期望输出和实际输出，用于做题人调试。
- 历史格式 `visible.cases` / `hidden.cases` 以及旧字段 `id` / `expected` / `actual` 仍会被提交结果页兼容，但新评测器应使用上述标准字段。
- 更完整的协议说明见 [Evaluator SDK](../mechanisms/evaluator-sdk.md)。
