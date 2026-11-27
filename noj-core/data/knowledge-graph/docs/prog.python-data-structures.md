# Python 数据结构（列表、字典、集合、字符串）

## 直觉理解

算法与数据处理的代码有一半在挑选合适的“收纳盒”：要按顺序保存并随时追加用列表（`list`），要按编号或名称瞬间查表用字典（`dict`），要去重或做交并差运算用集合（`set`），文本清洗与格式化则靠不可变的字符串（`str`）。

## 核心概念

1. **列表与切片**：`nums[l:r:step]` 支持负索引与步长；尾部 `append` / `pop`
   为均摊 $O(1)$，头部插入为 $O(n)$（高频队头操作应改用 `collections.deque`）。
2. **字典与集合（哈希查找）**：`in` 判断成员在 `dict` / `set` 中均摊为
   $O(1)$，比列表线性查找 $O(n)$ 快几个数量级。频次统计常用 `dict.get(k, 0) + 1`
   或 `collections.Counter`。
3. **字符串不可变与拼接**：循环中频繁 `+`
   拼接字符串会反复复制内存，正确做法是先放列表再 `"".join(parts)`。

## 常见误区

- 把 `set` 当成有序结构按索引访问，或用列表嵌套百万次 `x in seen_list`
  导致超时（应改为 `seen_set`）。
- 浅拷贝误区：`b = a` 只复制引用，`a.append(1)` 会同步修改 `b`；独立副本需
  `a.copy()` 或嵌套结构 `copy.deepcopy(a)`。

## 例题与完整解析

**题目**：合并多条标签记录并统计每个不重复标签的得分总和，按总分降序返回前 2
名。

```python
records = [("rag", 80), ("llm", 90), ("rag", 60), ("cv", 75), ("llm", 40)]
scores: dict[str, int] = {}
for tag, pts in records:
    scores[tag] = scores.get(tag, 0) + pts

top2 = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))[:2]
print(top2)  # 输出: [('rag', 140), ('llm', 130)]
```

**逐步讲解**：用字典聚合将统计复杂度降至 $O(n)$，再按 `(-分数, 标签名)`
稳定排序取出 Top 2。
