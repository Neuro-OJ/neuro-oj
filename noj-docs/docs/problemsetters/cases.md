# 测试数据

NOJ 不规定测试数据格式。出题人可以把测试数据放在支持包里，也可以在 `evaluate.py` 中动态生成输入。只要 evaluator 能完成调用、评分和结果输出即可。

当前内置样例题使用 JSON Lines 作为示例约定：每一行是一个独立 JSON 对象。下面内容描述的是这种样例约定，不是平台强制要求。

## 可见用例约定

在样例题中，`visible.jsonl` 用于公开样例或可展示测试。Evaluator 可以把这些用例的输入、期望和实际结果写入 `details`，帮助做题人调试。

示例：

```json
{"id":"v001","input":"1 2\n","expected":3}
```

## 隐藏用例约定

在样例题中，`hidden.jsonl` 用于正式评分。Evaluator 可以读取隐藏用例，但应谨慎决定是否把隐藏输入、期望答案或错误细节返回给用户。

隐藏用例也可以使用同样结构：

```json
{"id":"h001","input":"2 2\n","expected":4}
```

## JSONL 字段约定

如果你采用 JSONL，可以至少包含：

- `id`：稳定用例 ID，便于定位。
- `input`：evaluator 解析的输入材料。
- `expected`：标准结果或评分参考。

需要部分分时，可以增加：

- `score`：该用例分值。
- `tags`：用例分类。
- `message`：对可见用例展示的说明。

## 避免泄露隐藏数据

隐藏数据是否出现在结果详情中完全由 evaluator 决定。建议：

- 可见用例可以展示输入、期望和实际输出。
- 隐藏用例默认只展示用例 ID、通过状态和错误类型。
- 不要把完整隐藏输入和标准答案直接放进面向用户的 `details`。

## 其他组织方式

NOJ 的自由度很高。以下方式都可以：

- 把样例和隐藏数据分别放在 `cases/visible/*.json` 与 `cases/hidden/*.json`。
- 使用一个 `cases.db` SQLite 文件，由 evaluator 查询测试点。
- 使用 CSV、YAML、纯文本或二进制资源。
- 根据随机种子或固定参数在 evaluator 中动态生成测试输入。
- 对模型输出类任务，在 evaluator 中加载评分脚本、规则文件或本地 fixture。

关键原则是：Solution 容器只接收 evaluator 通过 SDK 传过去的参数；隐藏数据和评分材料应留在 Evaluator 侧。
