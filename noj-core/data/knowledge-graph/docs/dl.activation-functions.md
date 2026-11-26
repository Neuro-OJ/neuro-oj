# 激活函数（ReLU、Sigmoid、Tanh、GELU）

## 直觉理解

如果神经网络只有矩阵乘法和偏置相加，那么不管堆叠 100 层还是 1000
层，本质上依然等价于一个单层线性模型（因为线性函数的复合还是线性）。激活函数就是在层与层之间插入的“非线性开关”，赋予网络拟合曲线与复杂决策边界的能力。

## 核心概念

1. **Sigmoid & Tanh**：Sigmoid 把输入压到 $(0, 1)$，常用于二分类输出概率；Tanh
   压到 $(-1, 1)$ 零中心。两者在两端饱和区导数接近 $0$，深层堆叠易梯度消失。
2. **ReLU（$\max(0, x)$）**：计算极快且正半轴导数恒为
   $1$，大幅缓解梯度消失；但负区间梯度为 0 可能引发“神经元死亡”。
3. **GELU（$x \cdot \Phi(x)$）**：在零点附近平滑过渡、保留轻微负值响应，已成为
   Transformer（BERT、GPT、LLaMA）中最主流的激活或门控变体（SwiGLU）基础。

## 常见误区

- 在多分类输出层前已经接了 `CrossEntropyLoss`（内部自带
  Softmax/LogSoftmax），却又手工多包了一层 Softmax 或 Sigmoid 导致梯度畸变。
- 在 ReLU 网络中学习率过大，一次性把大量神经元推入负半轴永久失去更新。

## 例题与完整解析

**题目**：对比输入 `x = [-2.0, -0.5, 0.0, 1.5]` 在 Sigmoid、ReLU 与近似 GELU
下的前向输出。

```python
import numpy as np

x = np.array([-2.0, -0.5, 0.0, 1.5])
sigmoid = 1.0 / (1.0 + np.exp(-x))
relu = np.maximum(0.0, x)
gelu = 0.5 * x * (1.0 + np.tanh(np.sqrt(2.0 / np.pi) * (x + 0.044715 * x**3)))

print("Sigmoid:", np.round(sigmoid, 4))
print("ReLU:   ", np.round(relu, 4))
print("GELU:   ", np.round(gelu, 4))
```

**逐步讲解**：ReLU 对所有负数严格截断为 0，而 GELU 对 `-0.5`
保留微小非零响应，在 0 点处平滑可导。
