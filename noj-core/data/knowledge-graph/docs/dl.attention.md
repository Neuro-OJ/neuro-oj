# 注意力机制（QKV 与 softmax）

## 直觉理解

读一句话时，理解"它"指代谁，你会把注意力集中在前面某个名词上。注意力机制把这件事写成运算：对每个位置，先问一个"查询"（我想找什么），再拿它和所有位置的"键"（每个位置能提供什么）比对相似度，得到的相似程度做归一化后成为权重，最后按权重把各位置的"值"（内容）加权求和。

## 核心概念

**QKV**。输入序列经三个线性变换得到
$Q=XW_Q$、$K=XW_K$、$V=XW_V$。缩放点积注意力：

$$\mathrm{Attn}(Q,K,V)=\mathrm{softmax}\!\left(\frac{QK^\top}{\sqrt{d_k}}\right)V ,$$

$d_k$ 是查询/键的维度。$QK^\top$ 中第 $(i,j)$ 个元素是位置 $i$ 的查询与位置 $j$
的键的点积。

**为何除以 $\sqrt{d_k}$**。若 $q$、$k$ 各分量独立、均值 0、方差 1，则点积方差为
$d_k$。维数大时点积数值很大，softmax 会饱和成近似 one-hot，梯度趋近于
0。缩放让方差回到 1 附近。

**多头**。把 $d$ 维切成 $h$
份，各头独立做注意力再拼接，能同时捕捉不同子空间的关联模式（如句法关系与共指关系）。

**掩码**。因果掩码把未来位置设为 $-\infty$ 后再
softmax，使每个位置只能看到自己及以前，这是解码器自回归生成的关键；padding
掩码则屏蔽补齐位置。

**复杂度**。序列长为 $n$ 时，注意力需要计算并存储 $n\times n$
的分数矩阵，时间与显存均为 $O(n^2)$，这是长上下文的主要瓶颈。

## 常见误区

- 把注意力权重直接解释为"模型的可解释依据"：权重高表示聚合多，但贡献还经过 $V$
  与后续层，解读需谨慎。
- 忘记 softmax 按行归一化：应该是每一行（每个查询）的权重和为 1。
- 忽略缩放因子，导致维度大时训练不稳定。
- 混淆自注意力与交叉注意力：自注意力的 Q、K、V 来自同一序列，交叉注意力的 Q
  来自解码器，K、V 来自编码器。
- 在因果语言模型中漏掉掩码，造成训练时"看到未来"，训练损失很低但生成完全无效。
- 认为多头只是"多算几次"：各头的参数不同，且总维度通常保持为
  $d$，因此计算量相近。

## 例题与完整解析

**题目**：用手写实现单头缩放点积注意力，并对比缩放因子对 softmax
分布锐度的影响。

```python
import numpy as np

rng = np.random.default_rng(0)

def softmax(z):
    z = z - z.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)

n, d, dk = 4, 8, 16
X = rng.normal(size=(n, d))
Wq, Wk, Wv = (rng.normal(0, 1 / np.sqrt(d), size=(d, dk)) for _ in range(3))
Q, K, V = X @ Wq, X @ Wk, X @ Wv

scores = Q @ K.T
for scale in (1.0, np.sqrt(dk)):
    w = softmax(scores / scale)
    print(f"scale={scale:5.2f} 最大权重={w.max():.3f} 分布熵={-np.sum(w * np.log(w), 1).mean():.3f}")

W = softmax(scores / np.sqrt(dk))
print("权重行和:", np.round(W.sum(1), 6))
print("注意力输出形状:", (W @ V).shape)

# 因果掩码示例
mask = np.triu(np.ones((n, n)), k=1).astype(bool)
masked = np.where(mask, -np.inf, scores / np.sqrt(dk))
print("因果权重(行和=1, 上三角为0):\n", np.round(softmax(masked), 3))
```

**逐步讲解**：

1. `Q @ K.T` 得到 $n\times n$
   的相似度矩阵，每行对应该查询位置对所有键位置的打分。
2. 不缩放时（scale=1），随机初始化的点积方差约为 $d_k=16$，分数跨度大，softmax
   最大权重明显更大、熵更低，接近 one-hot；除以 $\sqrt{16}=4$
   后方差归一，分布更平滑、熵更高。实际训练中这直接影响梯度是否畅通。
3. 每行权重之和为 1，`W @ V` 就得到每个位置的新表示，形状仍是 $n\times d_k$。
4. 因果掩码用上三角布尔矩阵把未来位置置为 $-\infty$，softmax 后这些位置权重恰为
   0。第 0 行只能看自己，权重为 1；第 $i$ 行只在 $0..i$ 上分配权重。
5. 多头实现：把 $d$ 维分成 $h$ 份，对每份分别做上述运算后拼接，再乘输出投影
   $W_O$。

## 下一步

去练习本知识点下的权重计算与小规模手算题。之后可以学习 Transformer
架构，看注意力与残差、层归一化、前馈层如何组成完整模块，也可以回顾嵌入表示理解
QKV 的输入来源。
