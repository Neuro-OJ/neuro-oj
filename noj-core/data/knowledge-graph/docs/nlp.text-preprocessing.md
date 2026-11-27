# 文本预处理

## 直觉理解

计算机只认识数字，不认识汉字或英文句子。文本预处理就是把长短不一、大小写混乱、充满标点和噪声的自然语言“清洗干净、切成基本词元、再查表映射成整数索引”，让模型拿到规整的数值张量。

## 核心概念

1. **规范化与清洗**：统一大小写、全半角、Unicode
   标准化（NFKC），按任务需要决定是否剔除 HTML
   标签、多余空白或标点（注意：情感分析与代码生成不能粗暴删标点）。
2. **分词与粒度权衡**：
   - **词级（Word）**：符合语义直觉，但面对新词、拼写变体容易出现 `<unk>`
     未登录词爆炸。
   - **字符级（Char）**：词表极小、无未登录词，但序列过长、单字符语义信息太薄。
   - **子词级（Subword，BPE/WordPiece）**：现代预训练模型首选，兼具高覆盖率与可控词表大小。
3. **词表构建与特殊标记**：只基于训练集统计词表，保留
   `<pad>`、`<unk>`、`<bos>`、`<eos>` 等控制标记，并将同一批次填充到等长同时生成
   `attention_mask`。

## 常见误区

- 把测试集文本混入词表或停用词统计过程，造成隐式信息泄露。
- 随手套用默认英文停用词表做情感/否定判断，把 `"not"`、`"no"`、`"never"`
  误删导致整句语义反转。

## 例题与完整解析

**题目**：对两条英文短句完成仅基于训练集的词表构建、编码与等长填充。

```python
texts = ["AI is fast!", "AI is fun and fair"]
vocab = {"<pad>": 0, "<unk>": 1}
for line in texts:
    for tok in line.lower().strip("!").split():
        if tok not in vocab:
            vocab[tok] = len(vocab)

def encode(sentence: str, max_len: int):
    ids = [vocab.get(t, vocab["<unk>"]) for t in sentence.lower().strip("!").split()]
    ids = ids[:max_len] + [vocab["<pad>"]] * max(0, max_len - len(ids))
    mask = [1 if i != vocab["<pad>"] else 0 for i in ids]
    return ids, mask

print("Vocab:", vocab)
print("Encoded:", encode("AI is great", 5))
```

**逐步讲解**：未出现在训练词表中的 `"great"` 被安全映射为 `<unk>`（编号
`1`），末尾补 `0` 并在 `mask` 中标记为无效位置 `0`，防止注意力读入填充噪声。
