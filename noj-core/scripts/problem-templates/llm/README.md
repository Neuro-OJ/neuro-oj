# 模板：LLM 工程题（提示词构造）

由 `problem init --template llm` 生成的**可直接验题**的 LLM 工程题模板：选手实现
`build_prompt(message)`，评测脚本把提示词发给大模型并检查回复。

## 文件

| 路径            | 说明                                               |
| --------------- | -------------------------------------------------- |
| `problem.json`  | 声明 `llm` 调用预算（`max_calls` / `max_tokens`）  |
| `statement.md`  | 题面：接口、资源与评分                             |
| `template.py`   | 选手初始代码，入口保持未实现                       |
| `evaluate.py`   | 评测脚本：调用选手函数 → `llm.complete` → 检查回复 |
| `visible.jsonl` | 可见用例（不计分）                                 |
| `hidden.jsonl`  | 隐藏用例（正式评分）                               |
| `submissions/`  | 参考解答与断言，**不进题目包**                     |

## 验题

```bash
# 离线 mock：大模型回显最后一条 user 消息，只验证调用链路、预算与结果解析
noj-cli problem test .
# 真实效果：接平台网关（需要评测 token）
noj-cli problem test . --allow-network --llm-gateway <url> --llm-token <token>
```

mock 下满分解与错解的区分来自「提示词里有没有带上留言原文」；真实模型下还取决于
提示词质量，请用真实网关再验一次。

## 改造步骤

1. 改写题面与 `template.py` 的接口；
2. 改写 `evaluate.py` 的判定（包含关系、JSON 解析、打分模型等），并在题面写清；
3. 按「用例数 × 每例调用次数 × 2（含 SDK 重试）」重新估算 `max_calls`，
   按提示词与回复长度估算 `max_tokens`；不得超过平台上限（100 次 / 50000
   token）；
4. 更新 `submissions/` 与 `expect.json`。

## 常见坑

- **LLM 调用预算**：预算不足时后面的用例会因额度耗尽失败，整次评测记为平台错误；
  本地 mock 同样执行预算，`problem test` 能提前发现；
- **大模型只能由评测脚本调用**：选手代码没有网络，也拿不到评测 token；
- **LLM 调用失败不要吞掉**：网关故障、额度耗尽是平台问题，应上抛而不是记 0 分；
- **结果不稳定**：用 `temperature=0` 并限制
  `max_tokens`，判定尽量宽容（如包含关系）；
- **隐藏用例泄露**：隐藏用例不回显 input / expected / 模型回复。
