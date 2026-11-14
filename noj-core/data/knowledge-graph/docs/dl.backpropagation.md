# 反向传播

## 直觉理解

前向传播像一条流水线：原料从入口经过若干工位加工成成品。成品不合格时，我们要知道每个工位的旋钮该往哪边拧。反向传播就是从成品往回走，把"成品误差对每个工位参数的敏感度"逐站传回。它的数学内容其实只是**微积分链式法则**，但通过复用中间结果，计算量被压到与前向几乎相同。

## 核心概念

**计算图视角**。把网络看成由加、乘、激活等基本运算组成的图。前向时保存每个节点的输出；反向时对每个节点使用其局部导数，把上游传来的梯度乘以局部导数继续下传。

**链式法则的具体形式**。对第 $l$ 层
$z^{(l)}=W^{(l)}a^{(l-1)}+b^{(l)}$、$a^{(l)}=\phi(z^{(l)})$，记
$\delta^{(l)}=\partial L/\partial z^{(l)}$，则

$$\delta^{(l)} = \big(W^{(l+1)\top}\delta^{(l+1)}\big)\odot\phi'(z^{(l)}),\qquad
\frac{\partial L}{\partial W^{(l)}}=\delta^{(l)}a^{(l-1)\top},\qquad
\frac{\partial L}{\partial b^{(l)}}=\delta^{(l)}.$$

输出层梯度由损失决定，例如 softmax + 交叉熵时 $\delta^{(\text{out})}=\hat y-y$。

**为何高效**。朴素地逐个参数做数值差分需要 $O(P)$ 次前向（$P$
为参数量）；反向传播一次前向加一次反向就得到全部梯度，代价与前向同阶。

**反向模式自动微分**。PyTorch 的 `.backward()`、JAX 的 `grad`
都是它的工程实现，且支持动态图与复杂的控制流。

## 常见误区

- 忘记在激活函数处乘局部导数 $\phi'(z)$，只传了线性部分。
- 矩阵转置方向弄反：回传时用 $W^\top\delta$，参数梯度里是 $\delta a^\top$。
- 混淆批量维度：损失若取均值，梯度也要除以批量大小。
- 希望用数值差分验证时用太大的扰动：会引入截断误差；太小时被浮点误差淹没。合理取值约
  $10^{-5}$，配合中心差分。
- 认为反向传播本身是优化算法：它只计算梯度，怎么走还是梯度下降等优化器的职责。
- 在反向之后才修改参与前向的张量，导致梯度与计算不一致。

## 例题与完整解析

**题目**：实现一个单隐藏层网络的前向与反向，并用中心差分检验手写梯度的正确性。

```python
import numpy as np

rng = np.random.default_rng(0)
X = rng.normal(size=(5, 3))
y = rng.integers(0, 3, size=5)  # 三分类标签

def loss_and_grad(params):
    W1, b1, W2, b2 = params
    z1 = X @ W1 + b1
    h = np.maximum(z1, 0)              # ReLU
    logits = h @ W2 + b2
    # 数值稳定的 softmax 交叉熵
    logits = logits - logits.max(1, keepdims=True)
    e = np.exp(logits)
    p = e / e.sum(1, keepdims=True)
    loss = -np.mean(np.log(p[np.arange(len(y)), y]))
    # 反向
    dlogits = p.copy()
    dlogits[np.arange(len(y)), y] -= 1
    dlogits /= len(y)
    gW2, gb2 = h.T @ dlogits, dlogits.sum(0)
    dz1 = (dlogits @ W2.T) * (z1 > 0)
    gW1, gb1 = X.T @ dz1, dz1.sum(0)
    return loss, (gW1, gb1, gW2, gb2)

params = [rng.normal(0, 0.5, s) for s in ((3, 4), (4,), (4, 3), (3,))]
loss, grads = loss_and_grad(params)
eps, max_diff = 1e-5, 0.0
for pi, P in enumerate(params):
    for idx in np.ndindex(P.shape):
        old = P[idx]
        P[idx] = old + eps
        lp, _ = loss_and_grad(params)
        P[idx] = old - eps
        lm, _ = loss_and_grad(params)
        P[idx] = old
        num = (lp - lm) / (2 * eps)
        max_diff = max(max_diff, abs(num - grads[pi][idx]))
print(f"损失={loss:.4f}  最大误差={max_diff:.2e}")
```

**逐步讲解**：

1. 前向保存中间量 `z1`、`h`、`p`，反向要用到它们（尤其是 ReLU 的掩码
   `z1 > 0`）。这就是"前向存中间值，反向用局部导数"。
2. softmax 交叉熵的梯度是 $\hat y-y$，再除以批量大小，因为损失取了平均。这行
   `dlogits[range, y] -= 1` 正是这一恒等式的手写实现。
3. 输出层是线性层，所以 `dW2 = h.T @ dlogits`，`db2` 是沿批量维求和。
4. 回传到隐藏层：`dlogits @ W2.T` 把梯度变成隐藏层形状，再乘以 ReLU
   导数掩码。ReLU 在 $z>0$ 处导数为 1，否则为 0。
5. 为数值稳定先减去行最大值，softmax 结果不变，避免 `exp` 溢出。
6. 中心差分 $(L(w+\epsilon)-L(w-\epsilon))/(2\epsilon)$ 的误差是
   $O(\epsilon^2)$，比单边差分更准。若最大误差在 $10^{-7}$ 到 $10^{-9}$
   量级，说明手写反向正确。若差很多，常见原因就是漏了转置或漏了激活导数。

## 下一步

去练习本知识点下的链式法则推导与小网络手算梯度题。之后可看梯度下降与优化器、激活函数，并在真实的
Transformer 架构中观察反向传播如何作用于注意力等复杂组件。
