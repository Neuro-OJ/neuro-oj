# 优化器（动量、Adam、AdamW）

## 直觉理解

朴素梯度下降只看脚下这一步的坡度，遇到窄长峡谷地形会在两侧峭壁之间来回震荡、沿着谷底走得很慢。现代优化器通过“记录历史惯性（动量）”和“为不同参数分别缩放步长（自适应学习率）”，让下山路线既稳又快。

## 核心概念

1. **SGD + 动量（Momentum）**：维护速度指数滑动平均
   $v_t = \beta v_{t-1} + g_t$，在方向一致的维度加速前进，在震荡维度互相抵消。
2. **Adam（Adaptive Moment Estimation）**：同时跟踪梯度的一阶矩
   $m_t$（均值/方向）和二阶矩
   $v_t$（平方均值/尺度），并对初期零偏置做偏差修正，有效缓解稀疏特征或尺度差异大的问题。
3. **AdamW（解耦权重衰减）**：标准 L2 正则在 Adam
   中会被自适应分母缩放，削弱对大梯度参数的正则效果。AdamW
   将权重衰减从梯度计算中剥离，直接按
   $\theta_{t+1} = (1 - \eta\lambda)\theta_t - \eta\hat{m}_t/(\sqrt{\hat{v}_t}+\epsilon)$
   更新，是大模型训练默认配置。

## 常见误区

- 在大模型或 Transformer 微调中误用带 L2 `weight_decay` 的旧版 `Adam` 而非
  `AdamW`，导致正则强度随梯度历史失真。
- 只调整学习率却忽略梯度裁剪与学习率预热（Warmup），导致 Adam
  初期二阶矩估计不稳定时参数震荡发散。

## 例题与完整解析

**题目**：对比纯梯度下降与带偏差修正的 Adam
单步更新在梯度尺度差异较大场景下的表现。

```python
import numpy as np

theta_sgd = np.array([1.0, 1.0])
theta_adam = np.array([1.0, 1.0])
g = np.array([10.0, 0.01])  # 第一维梯度大，第二维梯度小

lr = 0.1
theta_sgd = theta_sgd - lr * g

m = 0.1 * g
v = 0.001 * (g ** 2)
m_hat = m / (1 - 0.9)
v_hat = v / (1 - 0.999)
theta_adam = theta_adam - lr * m_hat / (np.sqrt(v_hat) + 1e-8)

print("SGD  updated:", np.round(theta_sgd, 4))
print("Adam updated:", np.round(theta_adam, 4))
```

**逐步讲解**：梯度相差 $1000$ 倍时，SGD 第一维步子过大而第二维几乎停滞；Adam
归一化二阶矩后，两维参数均迈出尺度一致的 `0.1` 步长。
