# LoRA

## 直觉理解

给一个 70 亿参数的大模型全量微调，光是优化器状态就要上百 GB
显存；但实验发现微调特定下游任务时，模型真正需要改动的方向其实集中在一个“很低维的子空间”里。LoRA
就像给厚重的主教材夹入两张薄薄的便利贴：冻结原书一字不动，只训练两张小纸片去乘出微调增量，训练完还能直接并回原权重里不拖慢推理速度。

## 核心概念

1. **低秩分解原理**：对预训练权重矩阵
   $W_0 \in \mathbb{R}^{d \times k}$，旁路注入两个小矩阵
   $B \in \mathbb{R}^{d \times r}$ 与 $A \in \mathbb{R}^{r \times k}$（秩
   $r \ll \min(d, k)$），前向计算变为： $$h = W_0 x + \frac{\alpha}{r} B A x$$
2. **初始化约束**：$A$ 用高斯随机初始化，$B$ 初始化为全 `0`，确保训练第 0
   步时旁路增量 $\Delta W = BA = 0$，模型行为与预训练起点完全一致。
3. **关键超参选择**：
   - **秩 $r$**（常见 `8, 16, 32`）与缩放系数 $\alpha$；
   - **挂载模块（`target_modules`）**：只改 `q_proj, v_proj`
     往往不如同时覆盖注意力投影与 MLP（`gate/up/down_proj`）。
   - **无额外推理延迟**：部署前直接执行 $W' = W_0 + \frac{\alpha}{r} BA$
     即可零开销合并。

## 常见误区

- 把 $A$ 和 $B$ 同时初始化为全 `0`，导致反向传播时两者梯度恒为
  0、旁路完全训不动。
- 忽视 QLoRA
  量化底座反量化带来的精度折中与训练速度差异，或只改一两个线性层导致复杂格式遵循学不进去。

## 例题与完整解析

**题目**：某线性层维度为 `4096 x 4096`，设置 LoRA 秩
`r = 16`，计算单层参数节省比例，并验证初始化零增量与权重无损合并。

```python
import numpy as np

d, k, r = 4096, 4096, 16
full_params = d * k
lora_params = d * r + r * k
print(f"LoRA ratio: {lora_params / full_params:.4%} ({lora_params} vs {full_params})")

# 小规模数值验证无损合并
W0 = np.ones((4, 4))
A = np.random.randn(2, 4) * 0.01
B = np.zeros((4, 2))
x = np.array([1.0, 2.0, -1.0, 0.5])

assert np.allclose(W0 @ x + (B @ A) @ x, (W0 + B @ A) @ x)
print("Zero-init and merge check passed.")
```

**逐步讲解**：单层可训练参数从 `1677 万` 降至 `13.1 万`（约 `0.78%`）；$B=0$
保障初始输出不变，且训练后可直接相加合并回主干矩阵。
