# 采样策略（温度、top-k、top-p）

## 直觉理解

模型每次只算出词表上每个候选词的概率分布，但真正要选出下一个词时，全选最高概率会让回答干瘪复读，完全按原始概率盲抽又容易挑中长尾胡话。温度调节分布有多“尖锐”，`top-k`
和 `top-p` 则在抽签前把明显不靠谱的长尾候选剪掉。

## 核心概念

1. **温度缩放（Temperature $T$）**：按
   $p_i = \frac{\exp(z_i / T)}{\sum_j \exp(z_j / T)}$ 调整概率分布。
   - $T \to 0$：分布极度尖锐，逼近贪心确定输出，适合代码与评测题。
   - $T > 1$：拉平概率差距，增加创造力与多样性，但也提升幻觉风险。
2. **Top-k 截断**：每步仅保留概率最高的前 $k$
   个词元并重新归一化，但遇到模型非常确定（只有 1
   个合理词）或非常发散（几十个都合理）时不够灵活。
3. **Top-p（核采样，Nucleus
   Sampling）**：按概率从高到低累加，只保留最小集合使累积概率 $\ge p$（如
   `0.9`），候选数会随上下文确定性动态伸缩。

## 常见误区

- 同时把 `temperature` 设成 `0`
  又期待随机多次采样产生不同解法——$T=0$（或极小值）在数值上退化为确定性贪心。
- 误把“在代码/数学题里开高温度 + 高
  `top-p`”当成常规配置，结果破坏了格式约束和推理严谨性。

## 例题与完整解析

**题目**：给定候选 logits `[3.0, 2.0, 1.0, -1.0]`，观察在 `T=0.5` 与 `T=1.5`
下的概率变化，并做一次 `top-p = 0.85` 核截断。

```python
import numpy as np

logits = np.array([3.0, 2.0, 1.0, -1.0])

def softmax_temp(z, temp: float):
    s = (z - np.max(z)) / temp
    e = np.exp(s)
    return e / np.sum(e)

for t in (0.5, 1.0, 1.5):
    print(f"T={t}:", np.round(softmax_temp(logits, t), 4))

p = softmax_temp(logits, 1.0)
cum = np.cumsum(p)
cutoff = int(np.searchsorted(cum, 0.85)) + 1
print("Top-p kept count:", cutoff, "kept probs sum:", round(float(p[:cutoff].sum()), 4))
```

**逐步讲解**：`T=0.5` 时首位概率跃升至 `0.8668`，`T=1.5` 时平滑到
`0.5067`；在标准 `T=1.0` 下，前 `2` 个词累积概率已达
`0.9002 >= 0.85`，后两个长尾词元被安全剪除。
