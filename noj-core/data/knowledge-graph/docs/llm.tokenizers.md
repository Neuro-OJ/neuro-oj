# 子词分词（BPE、WordPiece）

## 直觉理解

英文单词成千上万，还有大小写、时态变化与代码变量名，纯按空格分词肯定会遇到没见过的词；但把文章拆成单个字母又会让上下文变得极长、模型算力吃不消。子词分词专门把高频完整词保留下来、把生僻词拆成常见词根/字块，在词表大小和序列长度之间找到黄金平衡点。

## 核心概念

1. **BPE（Byte Pair
   Encoding）**：从单字符/字节起步，统计训练语料中出现频次最高的一对相邻符号并不断合并，直到达到目标词表大小。GPT、LLaMA
   均使用字节级 BPE（Byte-level BPE），保证任何 Unicode/Emoji 都绝不会出现
   `<unk>`。
2. **WordPiece**：类似 BPE
   从小单元向上合并，但每次优先合并“让语料整体似然概率提升最大（点互信息最高）”的一对符号，常见于
   BERT，续接子词带 `##` 前缀。
3. **分词对大模型效果的影响**：中文/代码如果在基础词表中切得过碎（例如一个汉字
   2-3 个字节
   token），同样的上下文窗口能装下的有效语义会显著缩水，推理成本也会翻倍。

## 常见误区

- 以为大模型“按单词阅读”——事实上连空格、数字位数和代码缩进都会显著改变 Token
  边界，这也是模型对字母拼写、数数或对齐敏感的原因。
- 计算 LLM API 费用或提示词长度时直接按字符数估算，忽视中英文、代码、JSON 符号的
  Token 膨胀率差异。

## 例题与完整解析

**题目**：实现一轮最简 BPE
词频统计与最高频相邻字节对合并，观察词表如何从字符逐步长出高频词根。

```python
from collections import Counter

corpus = {"l o w </w>": 5, "l o w e s t </w>": 2, "n e w e r </w>": 6}
pairs = Counter()
for word, freq in corpus.items():
    syms = word.split()
    for a, b in zip(syms, syms[1:]):
        pairs[(a, b)] += freq

best_pair, count = pairs.most_common(1)[0]
print("Most frequent pair:", best_pair, "freq:", count)
```

**逐步讲解**：相邻对 `('e', 'r')` 和 `('r', '</w>')` 在 `"n e w e r </w>"`
中各自累计频次最高（`6` 次），BPE 第一轮便会将其合并为新符号 `"er"`
写入合并规则表（merges）。
