# 损失函数（MSE、MAE、交叉熵）

## 直觉理解

如果优化器是“下山的脚步”，损失函数就是“海拔地形图”：它用一个标量数值衡量当前模型预测和标准答案之间的差距有多大。只有选对了地形图，负梯度才会指向真正让任务指标变好的方向。

## 核心概念

1. **回归损失（MSE vs MAE）**：
   - **均方误差（MSE）**：$\frac{1}{n}\sum (y_i - \hat{y}_i)^2$，对大误差平方放大，平滑可微但对异常值敏感。
   - **平均绝对误差（MAE）**：$\frac{1}{n}\sum |y_i - \hat{y}_i|$，对离群点更稳健，但零点不可导且接近零点梯度不衰减。
2. **交叉熵损失（Cross-Entropy）**：衡量预测概率分布 $q$ 拟合真实分布 $p$
   时的平均信息编码代价：$-\sum p(c)\log q(c)$。预测概率越接近真实类别，损失越趋近
   0；高置信度判错时会产生极大惩罚。
3. **Logits 与数值稳定**：框架中（如 PyTorch
   `CrossEntropyLoss`）直接接收未归一化的 `logits`，内部用 `LogSumExp` 技巧合并
   `LogSoftmax + NLLLoss`，避免指数溢出与梯度消失。

## 常见误区

- 在回归存在严重重尾噪声或极端异常值的数据上盲目使用
  MSE，导致少数脏样本把整条拟合线拖偏。
- 把类别编号直接当连续数值做 MSE 回归，错误引入了“类别 2 比类别 0 更接近类别
  1”的伪序关系。

## 例题与完整解析

**题目**：给定 3 分类样本的未归一化输出
`logits = [2.0, 0.5, -1.0]`，真实类别为第 `0` 类，计算手写交叉熵与 MAE/MSE
在预测偏差上的差异。

```python
import numpy as np

logits = np.array([2.0, 0.5, -1.0])
shifted = logits - np.max(logits)
probs = np.exp(shifted) / np.sum(np.exp(shifted))
ce_loss = -np.log(probs[0])

print("Softmax probs:", np.round(probs, 4))
print("Cross-Entropy loss:", round(float(ce_loss), 4))
```

**逐步讲解**：先减去 `max(logits)` 再求 `exp` 是工程上标准防溢出写法；第 `0`
类概率约为 `0.7858`，交叉熵损失约 `0.2410`。若真实类别误标为第 `2` 类（概率仅
`0.0391`），损失会骤升到 `3.2410`。
