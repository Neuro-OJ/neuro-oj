# 归一化与标准化

## 直觉理解

如果一个特征是“年龄（0–100）”，另一个特征是“年收入（0–1000000）”，哪怕两者同样重要，未缩放时线性模型、KNN
或梯度下降也会被大数值特征彻底主导。缩放的目的就是让所有特征站在同一起跑线上比较和求梯度。

## 核心概念

1. **标准化（Standardization /
   Z-Score）**：$x' = \frac{x - \mu}{\sigma}$，结果均值约 $0$、标准差约
   $1$。对少量异常值比 Min-Max 更稳，最常用于线性模型、SVM、KNN、神经网络。
2. **归一化（Min-Max
   Scaling）**：$x' = \frac{x - x_{\min}}{x_{\max} - x_{\min}}$，把特征压缩到
   $[0, 1]$（如像素 `uint8 / 255.0`）。
3. **严格禁止跨集统计**：均值 $\mu$、标准差 $\sigma$ 或最值必须只用训练集 `fit`
   得到，验证与测试集只能 `transform`。

## 常见误区

- 在全局数据上先做完 `StandardScaler().fit_transform(X)` 再
  `train_test_split`——典型数据泄露。
- 当训练集某个常量特征标准差 $\sigma = 0$ 时直接除零得到
  `NaN`（工程上应设下限或保留 0）。
- 树模型（随机森林 / GBDT）对单调缩放不敏感，不需要强行标准化。

## 例题与完整解析

**题目**：实现安全的 Z-Score
标准化器，防止零方差除零，并分别拟合训练集、转换测试集。

```python
import numpy as np

X_tr = np.array([[1.0, 200.0], [2.0, 200.0], [3.0, 200.0]])
X_te = np.array([[4.0, 200.0]])

mu = X_tr.mean(axis=0)
sd = X_tr.std(axis=0)
safe_sd = np.where(sd > 1e-12, sd, 1.0)

X_tr_scaled = (X_tr - mu) / safe_sd
X_te_scaled = (X_te - mu) / safe_sd
print("测试集标准化结果:", np.round(X_te_scaled, 3))
```

**逐步讲解**：第二列在训练集上方差为 0，通过 `safe_sd` 替换成 `1.0` 保持该列输出
0，避免出现 `NaN` 污染整批梯度。
