# 评测流程与范式

## 直觉理解

没有度量就没有改进。大模型一次改动提示词、采样温度或者 LoRA
权重后，“凭感觉多问两个例子觉得变聪明了”往往非常不可靠。科学的评测流程就像设计标准化试卷：明确考什么、准备好防泄漏题库、固定判分尺子，再通过错误归因指导下一轮迭代。

## 核心概念

1. **完整四步评测闭环**：
   - **明确能力与场景边界**：区分通用知识、指令遵循、代码执行、RAG
     忠实度还是安全拒答；
   - **构造分层测试集**：覆盖正常主流样本、边界极端情况与对抗诱导用例；
   - **选择可复现判分器（Scorer）**：优先确定性规则/单元测试判分，复杂开放任务再用人工盲评或受控裁判模型并校验一致率；
   - **切片与归因分析**：不只盯平均总分，而是按任务难度、错误类型（格式错 vs
     逻辑错 vs 幻觉）拆解短板。
2. **闭卷基准 vs
   场景盲测**：公开跑分衡量通用上限，真实业务灰度与回归集决定上线生死。

## 常见误区

- 只看总平均分做选型决策，忽视模型在最关键约束（如 JSON
  解析失败率或幻觉率）上的局部崩盘。
- 每次改动同时变更提示词、温度和底层模型，却不记录版本快照，导致结果波动无法复现也无法归因。

## 例题与完整解析

**题目**：按“错误类型切片汇总”思路统计一次模型评测日志的总通过率及核心败因分布。

```python
from collections import Counter

results = [
    {"passed": True, "error_type": None},
    {"passed": False, "error_type": "format_error"},
    {"passed": False, "error_type": "reasoning_error"},
    {"passed": False, "error_type": "format_error"},
    {"passed": True, "error_type": None},
]

pass_rate = sum(1 for r in results if r["passed"]) / len(results)
error_dist = Counter(r["error_type"] for r in results if not r["passed"])

print(f"Pass rate: {pass_rate:.1%}")
print("Failure breakdown:", dict(error_dist))
```

**逐步讲解**：总通过率仅 `40.0%`，而拆解失败类型后发现 2/3 的错题源于
`format_error`，说明优先修复结构化输出约束就能立刻大幅拉高可用率。
