# 结构化输出与答案抽取

## 直觉理解

聊天机器人多说几句寒暄没关系，但一旦模型要接入下游程序、工具调用或自动判题机，多一个
markdown 代码块标记或者少一个逗号就会让 `json.loads()`
直接崩溃。结构化输出就是通过提示约束、解码掩码与后处理校验，让模型稳定吐出机器可解析的数据。

## 核心概念

1. **三层防线保障稳定性**：
   - **提示与 Schema 层**：明确字段名、枚举值、类型定义与 Few-shot
     样例，减少自由发挥。
   - **解码约束层（Constrained Decoding / Guided
     JSON）**：利用有限状态机或语法文法屏蔽当前状态下不合法的下一个
     token（如必须出现引号或数字），从解码层面杜绝语法错误。
   - **校验与重试层**：使用 Pydantic / Zod
     解析校验失败时，把具体报错回传给模型做轻量重试修复。
2. **思维与答案解耦**：对于复杂推理题，让模型先写简短分析再把最终结论放入专用标签（如
   JSON 末尾字段或 XML 标签），避免强行“先输出格式再思考”损伤准确率。

## 常见误区

- 只靠在 Prompt 里写“请只输出纯 JSON，不要废话”就上生产，忽略了模型依然可能包裹
  `` ```json `` 或在末尾补充解释。
- 把“结构化 JSON
  强约束”在推理链前段直接卡死，研究显示过早锁死输出文法会明显降低数学与逻辑题准确率。

## 例题与完整解析

**题目**：编写一个健壮的 LLM 文本答案抽取器，兼容带 Markdown 代码块包裹的 JSON
以及必需字段 Schema 校验。

````python
import json
import re

raw = """思考完成，结果如下：
```json
{"answer": "B", "confidence": 0.92}
```"""

match = re.search(r"\{[\s\S]*\}", raw)
if not match:
    raise ValueError("Missing JSON object")
data = json.loads(match.group(0))
assert data["answer"] in {"A", "B", "C", "D"}
assert 0.0 <= float(data["confidence"]) <= 1.0
print("Parsed structured result:", data)
````

**逐步讲解**：即便模型输出包含前缀说明与代码块围栏，正则提取首尾对象边界再校验枚举与区间，依然能可靠接住并发现违规格式。
