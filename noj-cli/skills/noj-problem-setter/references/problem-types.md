# 各题型要点

以下内容对应 `noj-cli problem init --template <name>` 生成的模板。模板目录里的
`README.md` 是最直接的参考，本页只列跨模板对比与容易漏掉的约束。

## 公共结构

```text
<slug>/
├── problem.json      # manifest：format_version 3，kind / submission_mode / runtime_config / llm
├── statement.md      # 题面（选手唯一规则来源）
├── evaluate.py       # 评测脚本（客观题没有）
├── README.md         # 出题说明（不展示给选手）
└── submissions/      # 参考解答 + expect.json，打包时自动排除
```

`runtime_config` 只写需要改的字段，镜像名缺省即可；`evaluator.time_limit_ms` 是
整次评测总时限，`solution.call_timeout_ms` 是单次函数调用超时。

## code：代码题（函数调用）

- 选手实现 `template.py` 里声明的函数，Solution 容器无网；
- 评测脚本用 `SolutionRunner` 调用，捕获
  `SolutionTimeoutError`、`NotFoundError`、
  `RejectedError`、`ConnectionError`（选手进程崩溃）与选手异常
  （`SystemError`），这些都只让当前用例失败；
- 可见用例只用于展示、不计分；隐藏用例等权计分；
- 改时限要同时改题面「数据范围与限制」与脚本里的单次调用超时。

## prediction：预测提交题（CSV）

- 没有 Solution 容器，`runtime_config` 只写 `evaluator`，**不能**配置 `llm`；
- 公开数据（训练集、测试集特征）由出题人放在外部 HTTPS 地址，在题面里给出下载
  链接；平台不托管公开数据，支持包只放 `evaluate.py` 与隐藏标签。模板题面里内联
  的小表格只是演示用的占位，改造时换成外链；
- 隐藏标签与公开数据必须同源同版本、ID 可对齐；
- 用 SDK 的 `load_predictions` + `assert_id_alignment`：缺少、多余、重复 ID 都判
  0，防止只交有把握的子集；
- 文件格式错误（缺列、编码错误、非数值）判 0 并说明原因，不要上抛；
- 不接受 pickle 等可执行格式；`artifact_max_size_mb` 按真实预测文件大小设置。

## llm：LLM 工程题

- 选手代码**不能**联网，也拿不到评测 token；只有评测脚本能调用 `llm.complete`；
- `problem.json` 的 `llm.max_calls` / `llm.max_tokens` 是整次评测预算，平台上限
  100 次 / 50000 token；
- 估算：`max_calls ≈ 用例数 × 每例调用次数 × 2`，留出 SDK 重试余量；
- `llm.LLMError`（网关故障、额度耗尽）不要捕获成 0 分，让它上抛为平台错误；
- 判定尽量宽容稳定：`temperature=0`，限制回复长度，用包含关系或容错的 JSON
  解析；
- 本地 mock 只回显最后一条 user 消息，满分解与错解的区分要能在 mock 下体现
  （例如错解漏掉了必要信息），真实效果用用户提供的网关再验一次。

## objective：客观题套卷

- `kind: "objective"`，不需要 `runtime_config`、`template.py` 与评测脚本；
- `questions.json` 是数组，每题：`key`（全卷唯一）、`type` （`single` /
  `multiple` / `judge`）、`prompt`、`options`（`{"key", "text"}`
  数组，判断题省略）、`answer`（**总是数组**：`["B"]`、`["A", "D"]`、`[true]`）、
  可选 `explanation`；
- 多选题完全匹配才得分，题干里提示「多选」；
- JSON 里的 LaTeX 反斜杠要写成 `\\`；
- 参考作答是 `{题号: [答案]}` 形式的 JSON。

## ui：界面题

- `submission_mode: "ui"`；`ui.html` 在沙箱 iframe 中运行，只能通过 `window.NOJ`
  与平台通信，不能发网络请求，资源全部内联，不超过 512 KiB；
- 选手提交的是参数 JSON，平台把它注入 `template.py` 为 `PARAMS` 及同名变量；
- `template.py` 不下发给选手，但**必须**容忍缺参与错误类型：一律
  `PARAMS.get(...)` 并校验，空参数 `{}` 要得 0 分而不是抛异常；
- 参数名为字母开头的字母、数字、下划线，最多 100 个；
- 参考解答是参数 JSON 文件，与界面提交内容等价。
