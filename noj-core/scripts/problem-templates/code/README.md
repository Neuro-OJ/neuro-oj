# 模板：代码题（函数调用）

由 `problem init --template code` 生成的**可直接验题**的代码题模板：选手实现
`solve(input_str)`，评测脚本在 Evaluator 容器里逐个用例调用并比对。

## 文件

| 路径            | 说明                                             |
| --------------- | ------------------------------------------------ |
| `problem.json`  | manifest：时限、单次调用超时、内存               |
| `statement.md`  | 题面（选手唯一可见的规则来源）                   |
| `template.py`   | 选手初始代码，入口保持未实现                     |
| `evaluate.py`   | 评测脚本：可见用例不计分，隐藏用例等权计分       |
| `visible.jsonl` | 可见用例（与题面示例逐字一致）                   |
| `hidden.jsonl`  | 隐藏用例（正式评分）                             |
| `submissions/`  | 参考解答与断言，**不进题目包**，只给本地验题使用 |

## 验题

```bash
noj-cli problem test .      # 满分解 100、错解 <50、空解 0
noj-cli problem lint --strict .
```

## 改造步骤

1. 改写 `statement.md`，把所有判分规则（格式、边界、容差）写清；
2. 改写 `template.py` 的函数签名，保持函数体未实现；
3. 改写 `evaluate.py` 的 `parse_output` 与比较逻辑，必要时加容差；
4. 重写 `visible.jsonl` / `hidden.jsonl`，隐藏用例覆盖边界（建议不少于 20 条）；
5. 更新 `submissions/`：满分解、典型错解、空解，以及 `expect.json` 里的断言；
6. 改动时限后同步题面「数据范围与限制」与 `evaluate.py` 的 `CALL_TIMEOUT_MS`。

## 常见坑

- **分数刻度**：`result.accept()` 接收 0–100 分，SDK 自动换算成平台的 ×100
  整数， 不要自己再乘 100；
- **隐藏用例泄露**：隐藏用例不能输出 `input` / `expected_output` /
  `actual_output`， 也不要把隐藏数据写进题面或可见文件（`lint` 会检查）；
- **选手异常 ≠ 评测异常**：选手代码出错只让该用例失败；评测脚本自身出错要上抛，
  否则「脚本坏了」会被记成选手 0 分；
- **资源限制**：`call_timeout_ms` 是单次调用超时，`evaluator.time_limit_ms` 是
  整次评测总时限，用例多时注意总时长；
- **回显安全**：打印选手输出前先压成单行，防止伪造 `---RESULT---`。
