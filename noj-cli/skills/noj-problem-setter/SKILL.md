---
name: noj-problem-setter
description: 为 Neuro OJ（NOJ）出题：选题型 → noj-cli problem init --template 生成可验题模板 → 改写评测脚本与数据 → 写满分/错解/空解 → problem test 本地 Docker 验题 → lint → pack/push。用户要在 NOJ 上出新题、改造题目包、写 evaluate.py、给题目补参考解答或排查验题失败时使用。
---

# NOJ 出题助手

帮助出题人在 Neuro OJ 上做出**可验证**的题目：每道题都要有满分解、错解与空解，
并在本地 Docker 沙箱里断言它们的得分，再交给平台。

## 硬性规则（任何时候都不能违反）

1. **不要搬运真实题库内容**。示例、题面、测试数据、参考解答一律原创合成；
   不得复制真实考试、竞赛或任何已有题库（包括用户私有题库）的原题、原数据
   与官方题解，也不要把它们写进本 skill 的示例或模板里。用户要求「照着某题改」
   时，只借鉴题型结构，内容重新设计。
2. **每一步改动后都重跑 `noj-cli problem test`**。验题不过就不进入 pack / push。
3. **不要把参考解答放进题目包**：参考解答只放在
   `submissions/`（打包时自动排除）， `template.py` 保持「未实现」状态。
4. **不要绕过平台限制**：不调高沙箱权限、不让 Solution 联网、不在本地之外的
   环境做验题；`push` 默认只建草稿，发布前要让用户确认。
5. **不要编造 SDK 接口**。不确定时打开模板里的 `evaluate.py` 或文档站
   「Evaluator SDK」页核对。

## 工作流

### 1. 选题型

先和用户确认题目考查什么、选手交什么，再选模板：

| 选手交什么                      | 模板         | 说明                                     |
| ------------------------------- | ------------ | ---------------------------------------- |
| 实现一个 Python 函数            | `code`       | 双容器：评测脚本逐个用例调用选手函数     |
| 一份预测结果 CSV                | `prediction` | 对照隐藏标签算指标，无选手容器           |
| 提示词 / Agent 逻辑，需调大模型 | `llm`        | 只有评测脚本能调用大模型，预算写在题包里 |
| 单选 / 多选 / 判断答案          | `objective`  | 平台直接判卷，不跑评测容器               |
| 在界面上填参数，不写代码        | `ui`         | `ui.html` 收集参数，注入脚本模板后评测   |

各题型的文件、判分方式与专属陷阱见
[references/problem-types.md](references/problem-types.md)。

### 2. 生成模板并先跑通

```bash
noj-cli problem init <slug> --template <code|prediction|llm|objective|ui> \
  --title "<题目标题>" --difficulty <easy|medium|hard> --no-interactive
noj-cli problem test problems/<slug>
```

生成的模板**原样就能通过** `problem test`（满分解 100、错解低分、空解 0）。
先确认这一点，说明本机 Docker、评测镜像与 `noj-judge` 都就绪；跑不通时按
「验题失败排查」处理，不要先改题。

`<slug>` 用小写字母、数字、连字符。生成后读一遍题目目录里的 `README.md`，
它列出了该模板的改造步骤与常见坑。

### 3. 改写题面与接口

- `statement.md` 是选手**唯一**的规则来源：输入输出格式、边界、容差、计分方式、
  时限内存都要写清，评测脚本不能检查题面没写的东西；
- 改 `template.py` 的函数签名时保持函数体未实现（`raise NotImplementedError` 或
  `TODO`），否则 `lint` 会报 `quality/template-may-be-complete`；
- 可见用例（`visible.jsonl`）要与题面示例逐字一致。

### 4. 改写评测脚本（`evaluate.py`）

保留模板的骨架，只改解析、比较与计分：

- **选手侧错误只让该用例失败**：超时、异常、缺函数、返回类型不对、预测文件
  格式错，都记该用例 0 分并给出原因；
- **评测脚本自身的错误要上抛**：数据文件读不到、LLM 网关错误（`llm.LLMError`）、
  断言失败等，让平台记为系统错误，而不是给选手 0 分；
- 用 `result.accept(score, details={...})` 上报，`score` 是 **0–100**；
- 隐藏用例的 `details.cases` 项必须带 `hidden: True`，且**不得**带 `input` /
  `expected_output` / `actual_output`；每个用例都要显式写 `hidden` 字段；
- 打印选手输出前压成单行并截断，避免伪造结果分隔符。

### 5. 写数据与参考解答

- 隐藏用例覆盖边界与反例（代码题建议不少于 20 条），数据自己生成，不抄题库；
- `submissions/` 至少三份：
  - `good.*`：满分解，必须稳定 100；
  - `wrong.*`：典型错解（常见误解或漏边界），用来证明数据能区分对错；
  - `empty.*`：空解 / 空参数 / 空卷，必须得 0 且**不能**变成平台错误；
- `submissions/expect.json` 写断言，例如
  `{"good": "=100", "wrong": "<50", "empty": "=0"}`。错解的阈值要真实反映
  它的得分，不要放宽到「怎样都能过」。

### 6. 验题与校验

```bash
noj-cli problem test problems/<slug>          # 断言全部满足才算通过
noj-cli problem lint --strict problems/<slug> # 含 SHOULD 层，必须零发现
```

LLM 题默认用离线 mock（回显最后一条 user 消息），只验证链路、预算与解析；
需要验证真实效果时，让**用户本人**提供网关地址与评测 token：

```bash
noj-cli problem test problems/<slug> --allow-network \
  --llm-gateway <url> --llm-token <token>
```

不要自己去找、猜或写入 token。

### 7. 打包与上传

```bash
noj-cli problem pack problems/<slug>                       # 生成 zip，submissions/ 自动排除
noj-cli problem push problems/<slug> --server <平台地址> --domain <域>
```

`push` 默认导入为草稿；`--publish` 会立即发布，只在用户明确要求时使用。
更新已有题目请在平台编辑页操作。

## 常见坑速查

| 坑              | 正确做法                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| 分数刻度        | `result.accept()` 收 0–100，SDK 自动换算成平台整数，**不要再乘 100**                                                |
| 隐藏用例泄露    | 隐藏数据不进题面、可见文件和 `details`；`lint` 的 `quality/hidden-case-leak` 会查可见文件                           |
| 选手错 ≠ 平台错 | 选手异常只让用例失败；脚本 bug、LLM 网关错误上抛                                                                    |
| 资源限制        | `call_timeout_ms` 是单次调用超时，`evaluator.time_limit_ms` 是整次评测总时限；用例多时按总时长估算                  |
| LLM 调用预算    | `max_calls` ≈ 用例数 × 每例调用次数 × 2（含重试），`max_tokens` 按提示词与回复长度估；平台上限 100 次 / 50000 token |
| 结果不稳定      | LLM 判定用 `temperature=0`、限制 `max_tokens`、宽容判定（包含关系、JSON 容错）                                      |
| 空解报错        | 空提交、空参数 `{}`、表头-only CSV 都要能正常得 0 分                                                                |
| 依赖缺失        | 基础评测镜像不含 numpy / pandas，需要时随支持包提供或改用标准库                                                     |

## 验题失败排查

| 现象                               | 处理                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| 退出码 2，找不到 `noj-judge`       | 用 `--judge-bin` 或 `NOJ_JUDGE_BIN` 指定；版本过旧时更新                            |
| 所有解答得分都是 `-`，没有容器输出 | Docker 守护进程不可用或镜像缺失；先 `docker info`，再构建 `runtime_config` 中的镜像 |
| 满分解不是 100                     | 读该解答的 stderr 摘要与 `details`，多半是比较逻辑或数据错误                        |
| 错解也拿了 100                     | 数据区分度不够，补能卡住该错解的隐藏用例                                            |
| 空解变成平台错误                   | 评测脚本把选手异常上抛了，按「选手侧错误只让该用例失败」改                          |
| LLM 题 429 `out_of_usage`          | 预算不足，重新估算 `max_calls` / `max_tokens`                                       |

## 完成标准

向用户交付前逐条确认：

- [ ] `problem test` 通过，满分解 100、错解与空解得分符合 `expect.json`；
- [ ] `problem lint --strict` 零发现；
- [ ] 题面写清所有判分规则，示例与可见用例一致；
- [ ] 题面、数据与解答均为原创，没有真实题库内容；
- [ ] 未经用户确认没有执行 `push --publish`。
