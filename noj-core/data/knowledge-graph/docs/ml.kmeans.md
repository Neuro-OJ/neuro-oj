# K 均值聚类

## 直觉理解

给一堆没有标签的点，想自动分成 $K$ 组，使每组的点彼此靠近。K 均值先随便选 $K$
个中心，然后反复做两件事：把每个点分给最近的中心，再把每个中心挪到它名下所有点的平均位置。就像
$K$ 个磁铁在平面上来回移动，最后各吸引住一片点。

## 核心概念

**目标函数**（簇内平方误差，惯性）：

$$J = \sum_{k=1}^{K}\sum_{x\in C_k}\|x-\mu_k\|^2 .$$

**交替优化**。固定中心，把点分给最近中心（分配步骤使 $J$
不增）；固定分配，把中心更新为簇内均值（该步骤是 $J$ 对 $\mu_k$
的最小化解）。于是每次迭代 $J$ 单调不增，有限步内收敛，但只保证收敛到局部最优。

**K-means++
初始化**。第一个中心随机选，之后每次以与"到最近已选中心距离的平方"成正比的概率选下一个中心，能显著降低陷入差局部极小的概率。实践应多次运行取惯性最小的一次。

**选择 K**。肘部法（惯性随 $K$ 的拐点）、轮廓系数（衡量簇内紧致与簇间分离）。

**数据前提**。K
均值隐含假设簇是球形、大小相近、用欧氏距离衡量相似。特征必须先标准化，否则量纲大的特征会主导距离。它不适合发现环形、月牙形等非凸簇。

## 常见误区

- 不标准化特征，导致结果几乎只由量纲最大的特征决定。
- 只跑一次随机初始化就下结论。
- 用惯性比较不同 $K$ 时选"惯性最小"的无穷大 $K$：$K$
  越大惯性必然越小，必须用肘部或轮廓系数。
- 认为聚类标签有语义：簇编号是任意排列的，换一次随机种子编号可能完全交换。
- 在类别不平衡或离群点很多时直接用 K 均值：一个离群点就能把中心拽走，可考虑
  K-medoids 或先清洗。
- 把聚类当作有监督分类的评价方式去算准确率：无监督任务应看内部指标或下游用途。

## 例题与完整解析

**题目**：生成三团二维数据，实现 K-means++ 初始化与 Lloyd
迭代，输出最终惯性与各簇大小，并验证惯性随迭代单调不增。

```python
import numpy as np

rng = np.random.default_rng(0)
centers_true = np.array([[0, 0], [5, 0], [0, 5]])
X = np.vstack([c + rng.normal(0, 0.7, size=(50, 2)) for c in centers_true])

def kmeans_pp(X, k):
    centers = [X[rng.integers(len(X))]]
    for _ in range(k - 1):
        d2 = np.min([np.sum((X - c) ** 2, axis=1) for c in centers], axis=0)
        centers.append(X[rng.choice(len(X), p=d2 / d2.sum())])
    return np.array(centers)

centers = kmeans_pp(X, 3)
prev = np.inf
for it in range(20):
    d = ((X[:, None, :] - centers[None, :, :]) ** 2).sum(-1)
    labels = d.argmin(1)
    inertia = d[np.arange(len(X)), labels].sum()
    assert inertia <= prev + 1e-9
    prev = inertia
    centers = np.array([X[labels == k].mean(0) if np.any(labels == k) else centers[k]
                        for k in range(3)])
print("迭代", it + 1, "惯性", round(inertia, 2))
print("簇大小", np.bincount(labels, minlength=3))
print("中心", np.round(centers, 2))
```

**逐步讲解**：

1. K-means++ 用距离平方的概率挑选初始中心，让中心尽量分散，避免都落在同一团里。
2. 距离矩阵 `d`（形状 150×3）一次算完所有点到所有中心的平方距离，`argmin(1)`
   得到分配结果，这是向量化的分配步骤。
3. `assert inertia <= prev` 验证 Lloyd
   算法的单调性：每一步都不会让目标变差。这一性质是 K 均一定能停下来的原因。
4. 更新步骤用每簇均值作为新中心。若某簇为空（初始中心重复时可能发生），示例保留旧中心避免除零。真实实现里
   `scikit-learn` 用 `n_init` 多跑几次取最优。
5. 最终惯性约为每点平均噪声方差乘维度：噪声标准差 0.7，二维期望距离平方约
   $2\times0.49\approx1$，150 个点总惯性约 150 量级。簇大小应在 50
   附近，中心接近真实中心，说明还原成功。
6. 若数据量纲不同或不规则（例如两条月牙），应改用 DBSCAN 等方法。

## 下一步

去练习本知识点下的手算迭代与标准化重要性题。之后可以学习其他聚类（DBSCAN、层次聚类、谱聚类），看它们如何处理非凸形状与离群点。
