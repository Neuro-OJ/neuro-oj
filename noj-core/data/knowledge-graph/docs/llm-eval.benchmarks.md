# 公开评测集（MMLU、C-Eval、HELM）

## 直觉理解

既然每家机构都宣称自己的模型“超越人类”，就需要一套全行业公认的“统一高考卷子”来横评对比。代表性公开评测集（Benchmark）从学科知识、中文语境、数学推理到鲁棒性多维度出题，让不同参数规模的模型能在同一把尺子下看清强项与短板。

## 核心概念

1. **代表性多学科基准**：
   - **MMLU**：覆盖 57
     个英文学科（STEM、人文、社科等）的四选一题目，常用于评估世界知识储备与
     5-shot 学习能力。
   - **C-Eval /
     CMMLU**：面向中文语境与本土文化的多层次学科基准（含中学到职业资格考题），用于检验中文知识迁移与理解。
   - **HELM（Holistic
     Evaluation）**：不止看准确率，同时报告校准度、鲁棒性、公平性、偏见与推理效率等多维雷达指标。
2. **评测方法差异**：选择题既可以通过“直接读取选项 A/B/C/D 的 logprob
   概率比较”评测，也可以让模型先 CoT
   生成再正则抽取答案；两者分数往往显著不同，对比榜单时必须统一协议。

## 常见误区

- 只因为某模型在某个公开刷榜集分数差 1
  个点，就断言它在实际业务对话中一定更强或更弱——公开集往往存在提示模板敏感与数据污染风险。
- 把“logprob 强制四选一”的分数和“自由生成抽取答案”的分数直接混排比较。

## 例题与完整解析

**题目**：对比基于候选选项对数概率（Logprob
Scoring）与基于正则提取答案在评估四选一题目上的流程实现。

```python
import numpy as np

# 假设模型在最后一个提示位置对 A, B, C, D 四个 token 的 logprobs 分别为：
option_logprobs = {"A": -2.4, "B": -0.35, "C": -1.8, "D": -3.1}
gold = "B"

pred_logprob = max(option_logprobs, key=option_logprobs.get)
probs = np.exp(list(option_logprobs.values()))
probs = probs / probs.sum()

print("Logprob picked:", pred_logprob, "Correct:", pred_logprob == gold)
print("Normalized option probs:", dict(zip(option_logprobs.keys(), np.round(probs, 3))))
```

**逐步讲解**：通过直接比较选项 token
的对数似然可稳定避免“拒绝选任何一项或格式写歪”的噪音，在底座模型尚未经历对话微调时尤为常用。
