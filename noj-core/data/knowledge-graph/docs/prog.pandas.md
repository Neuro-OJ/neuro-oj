# Pandas 表格数据处理

## 直觉理解

如果说 NumPy 是纯粹的“数字矩阵计算器”，Pandas
就是面向带列名表格（`DataFrame`）的“可编程 Excel + SQL
引擎”：支持按列名筛选、缺失值清洗、按类别分组汇总以及多表连接，是数据科学与特征工程的日常主力。

## 核心概念

1. **Series 与 DataFrame**：单列是 `Series`，多列共用同一索引构成
   `DataFrame`。显式位置/标签索引用 `.iloc`（整数位置）与
   `.loc`（标签与布尔掩码）。
2. **分组聚合（`groupby`）与多表拼接（`merge`）**：`df.groupby("class_id")["score"].agg(["mean", "count"])`
   一行完成分组统计；`pd.merge(left, right, on="id", how="left")`
   对齐两张表字段。
3. **向量化过滤**：条件 `(df["score"] >= 60) & (df["active"])` 需用 `&` / `|`
   并为每个子条件加括号，避免使用 Python 的 `and` / `or`。

## 常见误区

- 链式索引赋值（如 `df[df["a"] > 0]["b"] = 1`）可能触发 `SettingWithCopyWarning`
  且修改不生效，应统一写为 `df.loc[df["a"] > 0, "b"] = 1`。
- 直接用 `df.iterrows()` 逐行循环百万行数据，速度比向量化运算慢百倍。

## 例题与完整解析

**题目**：清洗提交记录表，剔除空分数后按组别计算平均分与提交数。

```python
import pandas as pd

df = pd.DataFrame({
    "group": ["A", "A", "B", "B", "B"],
    "score": [80.0, None, 70.0, 90.0, 80.0],
})
clean = df.dropna(subset=["score"]).copy()
summary = clean.groupby("group", as_index=False).agg(
    avg_score=("score", "mean"),
    cnt=("score", "count"),
)
print(summary.to_dict(orient="records"))
```

**逐步讲解**：先用 `dropna(subset=["score"])`
清除无效样本，再通过命名聚合一次产出统计列，避免先算均值再人工改列名。
