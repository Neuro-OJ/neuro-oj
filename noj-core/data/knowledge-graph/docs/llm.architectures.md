# 主流架构（编码器-解码器、因果解码器、前缀解码器）

## 直觉理解

同样是基于
Transformer，不同大模型允许每个位置“偷看”哪些词元的规则并不一样：有的像做完形填空（前后全看），有的像接龙写作文（只能看前面写过的词），有的则先看完整道题再开始接龙。注意力掩码（Attention
Mask）的形状直接决定了模型擅长理解还是生成。

## 核心概念

1. **因果解码器（Causal Decoder-Only）**：使用下三角因果掩码，每个 token
   只能关注它自己及之前的
   token（代表：GPT、LLaMA、Qwen、DeepSeek）。训练目标统一为“预测下一个词元”，最容易通过扩展数据与算力产生涌现能力，推理时配合
   KV 缓存极高效。
2. **编码器-解码器（Encoder-Decoder）**：编码器双向阅读源文本，解码器通过交叉注意力结合输入并自回归生成（代表：T5、BART）。适合机器翻译、摘要等强条件映射任务，但结构较复杂、通用扩展研究不如
   Decoder-Only 集中。
3. **前缀解码器（Prefix
   Decoder）**：在同一组参数中，对输入前缀段使用双向注意力、对后续生成段使用单向因果注意力（代表：ChatGLM
   早期版本、UL2）。兼顾条件编码与统一参数。

## 常见误区

- 误以为 Decoder-Only
  无法做好分类或信息抽取——只要把类别标签放到提示输出端做自回归或取末尾 token
  表征，大规模预训练后的 Decoder-Only 在理解与抽取上同样极强。
- 在实现 Prefix LM
  时忘记把前缀与生成段之间的跨区可见性区分开，造成未来答案泄露给前缀部分。

## 例题与完整解析

**题目**：对比长度 `L=5`（前 2 个为输入前缀，后 3
个为生成答案）时因果解码器与前缀解码器的注意力可见矩阵（`1` 允许关注，`0`
屏蔽）。

```python
import numpy as np

L, prefix_len = 5, 2
causal_mask = np.tril(np.ones((L, L), dtype=int))
prefix_mask = causal_mask.copy()
prefix_mask[:prefix_len, :prefix_len] = 1

print("Causal mask:\n", causal_mask)
print("Prefix mask:\n", prefix_mask)
```

**逐步讲解**：前缀解码器前两行互相全可见（左上角 `2x2` 全
`1`），但前缀依然不允许偷看第 `2, 3, 4` 列的生成词；纯因果掩码则是严格下三角。
