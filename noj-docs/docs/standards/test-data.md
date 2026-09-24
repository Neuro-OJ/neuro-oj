# 测试数据与样例规范

Neuro OJ 不强制测试数据格式。出题人可以把测试数据放在纯净评测包里，也可以在 `evaluate.py` 中动态生成输入。只要 evaluator 能完成调用、评分和结果输出即可。本文给出**推荐约定**与**质量建议**。

> 本页是**建议规范**（SHOULD）：数据格式由你的 `evaluate.py` 自行决定，系统不做强制校验。但 `details.cases` 的字段约定直接影响提交详情页的展示与隐藏用例保护，属于**必须遵守**的协议。

## 推荐 JSONL 格式

内置样例题使用 JSON Lines 作为推荐约定：每一行是一个独立 JSON 对象。

```json
{"id":"v001","input":"1 2\n","expected":3}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `id` | 稳定用例 ID，便于与 `details.cases[].case_id` 对应 |
| `input` | evaluator 解析的输入材料 |
| `expected` | 标准结果或评分参考 |
| `score` | 可选，该用例分值（部分分） |
| `tags` | 可选，用例分类 |
| `message` | 可选，对可见用例展示的说明 |

::: tip `id` 不是 `case_id`
测试数据里的 `id` 是**你自定义**的；`details.cases[].case_id` 才是提交详情页展示的稳定标识。推荐让 `case_id` 直接取测试数据的 `id`，方便定位问题用例。
:::

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

::: info 支持包静态预检识别这两种命名
发布前预检会检查评测包根级是否存在 `visible.jsonl`，以及 `hidden.jsonl` 或 `hidden/` 目录；其他目录结构不会被预检识别为可见/隐藏数据（但仍可正常评测）。见[Web 题目编辑器 § 发布前预检](../problemsetters/web-editor.md#发布前预检)。
:::

## 可见 / 不可见语义

- **可见测试数据**：用于做题人调试展示（输入、期望、实际结果）。
- **不可见测试数据**：用于正式评分，默认不向用户展示输入/期望/细节。

### Neuro OJ 建议：全部正式评分数据使用不可见测试数据

LMCC 官方标准区分可见与不可见测试数据。Neuro OJ 采用更严格的建议：

- **正式评分**只使用不可见测试数据。⚠️ **这是 SHOULD，不是现状**：平台自带的样例题骨架 `noj-core/data/problems-src/1001/evaluate.py` 把可见与隐藏用例**等权计入**内容分（`8.0 × 通过数 ÷ 总用例数`；可见 10 条 + 隐藏 10 条 → 每个用例 0.4 分），题面样例因此会影响得分。
  - 正式比赛请在 `evaluate.py` 中**自行**只按隐藏用例计分；若沿用骨架口径，请在题面明确写"样例也计分"。
  - 骨架**不会**自动"只按隐藏用例计分"。此前本页写"与样例题骨架的 `evaluate.py` 一致：分数只来自隐藏用例"是**错误的**（2026-09-25 评审修正）。
- **可见数据**仅用于题面示例与调试：建议**不计入正式评分**（同样需要自己在评测脚本里实现）。

## 样例自测与调试输出

- 题面中的样例应同时作为 evaluator 的**可见自测用例**，建议**只用于调试与友好提示，不计入正式评分**（需在 `evaluate.py` 内自行实现；平台骨架默认会等权计分）。
- evaluator 应输出**对选手友好的调试信息**，且**明确易读**：结构化、标注输入/期望/实际、错误原因，方便选手定位问题。
- 调试信息**不得包含隐藏数据**。

## 避免泄露隐藏用例数据

隐藏用例的数据是否出现在结果详情中完全由 evaluator 决定。建议：

- 可见用例可以展示输入、期望和实际输出。
- 隐藏用例默认只展示用例 ID、通过状态和错误类型。
- **不要把完整隐藏输入和标准答案直接放进面向用户的 `details`**。

## 测试点结果详情（details.cases）

最终结果 JSON 只输出 `score` 与 `details`，不再输出顶层 `status`。为了让提交详情页统一展示测试点明细，新评测器建议在 `details` 中输出扁平的 `cases` 数组。每个测试点必须包含 `case_id`、`status`（**用例级状态**，不是提交最终判定）和布尔标记 `hidden`；`hidden` 是提交结果投影判断可见/隐藏用例的**唯一判定依据**，推荐字段如下：

| 字段 | 说明 |
|------|------|
| `case_id` | 稳定用例 ID，与测试数据中的 `id` 对应 |
| `status` | 该用例状态，如 `Accepted` / `WrongAnswer` / `RuntimeError` / `TimeLimitExceeded` |
| `hidden` | 必填布尔：`true` 为隐藏用例，`false` 为可见用例；缺失时旧脚本按 fail-safe 处理 |
| `visibility` | 可选兼容字段：`visible` / `hidden`，仅供人读与旧前端兼容；新评测器以 `hidden` 为准 |
| `time_ms` | 可选，该用例耗时（毫秒） |
| `memory_kb` | 可选，该用例内存（KB）；服务端结果白名单已收录，会随用例详情一并落库 |
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
      "hidden": false,
      "visibility": "visible",
      "time_ms": 12,
      "expected_output": "3",
      "actual_output": "3"
    },
    {
      "case_id": "h001",
      "status": "WrongAnswer",
      "hidden": true,
      "visibility": "hidden",
      "time_ms": 15
    }
  ]
}
```

约定：

- **隐藏用例**可以展示 `case_id`、`status`、`hidden`、`visibility`、`time_ms`、`memory_kb`，但 MUST NOT 写入 `input`、`expected_output`、`actual_output`。
- **可见用例**可以展示输入、期望输出和实际输出，用于做题人调试。
- 提交结果投影（`applySubmissionProjection`）会按 `hidden` 标记在竞赛场景剥离隐藏用例；如果 `cases` 中任意用例缺少 `hidden`，视为旧脚本，fail-safe 整份用例详情不返回。
- 历史格式 `visible.cases` / `hidden.cases` 以及旧字段 `id` / `expected` / `actual` 仍会被提交结果页兼容，但新评测器应使用上述标准字段，并确保每个用例都带 `hidden`。
- 更完整的协议说明见 [Evaluator SDK](../mechanisms/evaluator-sdk.md)。

::: danger 隐藏用例 MUST NOT 写入敏感输出
隐藏用例里写入 `input` / `expected_output` / `actual_output` 是**泄题**：竞赛场景的投影只按 `hidden` 标记剥离，一旦标记写错或缺失，这些内容就会进入面向选手的结果。请在评测脚本里按可见性分支裁剪字段，不要指望前端兜底。
:::

::: warning `hidden` 缺失 = 整份用例详情不返回
投影逻辑是"**任一**用例缺 `hidden` 就 fail-safe 整份 `cases` 不返回"，而不是只丢弃那一项。所以务必给**每一个**用例都显式写 `hidden`。
:::
