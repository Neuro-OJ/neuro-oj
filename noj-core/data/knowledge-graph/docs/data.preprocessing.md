# 数据清洗与缺失值处理

## 直觉理解

再精妙的模型如果吃进全是重复行、字符串乱码或 `NaN`
缺失值的脏数据，输出的也只能是噪音。数据清洗就是在喂给模型前，先把明显异常与缺失记录整理成格式统一、分布可信的干净输入。

## 核心概念

1. **去重与格式对齐**：去除完全重复样本，统一日期格式、大小写及单位（例如统一把“万元”和“元”折算为统一单位）。
2. **缺失值策略**：
   - 缺失极少且随机时可删行；缺失过多的无信息列可直接丢弃；
   - 数值列常用**训练集**中位数/均值填充（中位数对极端值更稳健），类别列常用众数或显式填
     `"__missing__"`（有时“缺失本身”就是强信号）。
3. **异常值识别**：通过业务阈值（如年龄为负）或分位数/IQR
   识别异常极值，区分“录入错误”与“真实稀少高价值样本”。

## 常见误区

- 在**划分训练集与测试集之前**用全量数据计算均值来填充缺失值，导致测试集分布泄露到训练集（验证成绩虚高）。
- 直接将缺失值填成 `0` 而不考虑业务含义（如温度 `0°C` 或收入 `0`
  会误导线性模型）。

## 例题与完整解析

**题目**：严格在训练集上统计中位数，再同时填充训练集和测试集的缺失列，并保留缺失指示标记。

```python
import numpy as np

train_x = np.array([10.0, np.nan, 14.0, 100.0])
test_x = np.array([np.nan, 12.0])

train_missing = np.isnan(train_x).astype(float)
test_missing = np.isnan(test_x).astype(float)
fill_val = float(np.nanmedian(train_x))  # 仅由训练集统计

train_filled = np.where(np.isnan(train_x), fill_val, train_x)
test_filled = np.where(np.isnan(test_x), fill_val, test_x)
print("填充值(中位数):", fill_val, "测试集填充结果:", test_filled, "缺失标记:", test_missing)
```

**逐步讲解**：用 `np.nanmedian` 避开极端值 `100.0` 的拉偏，同时保留 `missing`
二值指示特征防止丢失“数据未填写”的信号。
