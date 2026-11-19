# 本地验题（problem test）

> 不连平台，用与生产相同的 Docker 沙箱把题目包跑一遍，并断言「满分解得满分、
> 空解/错解得低分」。适合在 `pack` / `push` 之前发现 evaluator 写错、测试点没
> 覆盖、资源不足等问题。

## 前置条件

- 本机可用 Docker（与评测机相同的 Docker 守护进程即可）。
- 评测镜像已在本地构建，例如 `noj-evaluator-python`、`noj-solution-python` （OI
  题为 `noj-oi-cpp`）；镜像名以 `problem.json` 的 `runtime_config` 为准，
  缺省值见[评测镜像与运行时](../mechanisms/runtimes.md)。
- `noj-judge` 二进制：按 `--judge-bin` → 环境变量 `NOJ_JUDGE_BIN` → `PATH`
  的顺序查找。源码开发可直接用 `cargo build --bin noj-judge` 的产物。

`problem test` 本身只负责把题包转换成生产同款评测任务，真正的容器编排由
`noj-judge run-local` 完成（与线上 Worker 走同一评测入口）。

## 从模板起步

不想从空目录开始时，用 `--template` 生成一道**生成即可验题**的完整题目：

```bash
noj-cli problem init my-problem --template code --no-interactive
noj-cli problem test problems/my-problem     # 满分解 100、错解低分、空解 0
```

| 模板         | 题型                     | 评分方式                                   |
| ------------ | ------------------------ | ------------------------------------------ |
| `code`       | 代码题（双容器函数调用） | 隐藏用例等权；可见用例不计分               |
| `prediction` | 预测提交题（CSV）        | 对照隐藏标签算准确率，ID 严格对齐          |
| `llm`        | LLM 工程题               | 选手构造提示词，评测脚本调用大模型并检查   |
| `objective`  | 客观题套卷               | 单选 / 多选 / 判断，平台直接判分           |
| `ui`         | 界面题                   | `ui.html` 填参数，注入脚本模板后按 F1 评分 |

每个模板都带 `evaluate.py`（客观题除外）、`README.md`（改造步骤与常见坑）和
`submissions/`（满分解、错解、空解与 `expect.json`），生成后 `lint --strict`
零发现。先跑通 `problem test`，再按 README
逐步改成自己的题目，每改一步重跑一次。 源码仓库内的
`deno run -A noj-core/scripts/noj.ts problem init <slug> --template <name>`
生成同一份模板。

## 约定目录

```text
my-problem/
├── problem.json
├── evaluate.py
├── template.py
└── submissions/          # 参考解答（pack 时自动排除，不会进入题包）
    ├── good.py           # 满分解
    ├── wrong.py          # 错解
    ├── empty.py          # 空解
    └── expect.json       # 断言：{"good": "=100", "wrong": "<50", "empty": "=0"}
```

- 解答名取文件名（去掉扩展名）；目录形式的解答（产物/预测题）取目录名。
- `expect.json` 的值可写数字（等价 `=`）或 `"=100"`、`">=60"`、`"<50"` 这样的
  字符串，分数为 0–100 制。

## 用法

```bash
# 自动发现 submissions/ 下的解答与 expect.json
noj-cli problem test my-problem

# 显式指定解答与断言（可重复；path@name 可改名）
noj-cli problem test my-problem \
  --solution ref/full.py@good --solution ref/zero.py@empty \
  --expect good=100 --expect empty=0

# 机器可读输出
noj-cli problem test my-problem --json
```

执行顺序：先跑 `problem lint`（有错误即停止，退出码 1），再逐个解答评测，最后
对照断言。每个解答输出得分、状态、耗时与 stderr 摘要。

| 退出码 | 含义                                                  |
| ------ | ----------------------------------------------------- |
| 0      | 全部断言满足（无断言时：所有解答都成功跑完）          |
| 1      | lint 失败、断言不满足、解答评测出错或平台错误         |
| 2      | 用法错误：参数非法、解答不存在、找不到 `noj-judge` 等 |

## 各题型的执行方式

| 题型                  | 本地执行                                         |
| --------------------- | ------------------------------------------------ |
| 代码题（双容器）      | Evaluator + Solution 双容器，与线上一致          |
| OI 题（`kind: "oi"`） | 走 OI 评测路径；`.c` → C，`.cc/.cpp/.cxx` → C++  |
| 产物题                | 解答文件或目录（自动打 zip）作为提交产物         |
| 预测题                | 单个预测文件，先按线上上传规则校验文件名与文件头 |
| 界面题                | 解答为参数模板，按线上同样方式注入 `PARAMS`      |
| 客观题                | 不经 judge，直接用平台判卷逻辑；解答为答案 JSON  |

## 网络与 LLM 题

本地验题**默认不联网**：即使题目声明了 `evaluator.network.enabled`，也会被关闭
并给出提示。需要联网时必须显式开启：

```bash
noj-cli problem test my-problem --allow-network [--network <docker 网络名>]
```

LLM 题默认使用离线 mock（`--llm-mock`，默认开启）：SDK 的 `llm.complete`
回显最后一条 user 消息并返回 token 用量，不联网、不消耗额度，用于验证调用链路、
预算与结果解析。题目声明的 `llm.max_calls` / `llm.max_tokens` 在 mock
中同样生效： 超出时与线上网关一样返回 429
`out_of_usage`。要验证真实效果，改用自己的网关：

```bash
noj-cli problem test my-problem \
  --allow-network --llm-gateway https://gateway.example.com --llm-token <token>
```

`--no-llm-mock` 则完全不注入 LLM 配置（evaluator 调用 LLM 会失败）。

**沙箱约束不放宽**：本地容器与线上使用同一套 host 配置（`cap_drop ALL`、
`no-new-privileges`、默认 `network_mode none`，不挂载宿主 Docker socket），
`--network host` 会被拒绝；设置了 `JUDGE_REQUIRE_ISOLATED_DOCKER=true`
时同样要求 独立 Docker daemon。OI 原生题一律在本机 Docker
中运行，即使环境里配置了 `JUDGE_GO_JUDGE_URL` 也不会把源码和测试数据发往远程
go-judge。

**平台错误不算分**：evaluator 崩溃、输出非法评分等平台错误不会被当成 0 分，
该解答的所有断言直接判为不满足。按 Ctrl+C 中断时，会清理本次启动的评测容器。

## 常见问题

- **找不到 noj-judge 或版本过旧（退出码 2）**：用 `--judge-bin <路径>`
  指定，或设置 `NOJ_JUDGE_BIN`。评测前会先执行 `noj-judge run-local --help`
  探测；探测时 Redis 与 Docker 地址都指向不可达位置，旧版二进制即使误启动 Worker
  也无法消费 队列。
- **镜像不存在**：先在本地构建 `runtime_config` 中声明的镜像；镜像名必须符合平台
  白名单前缀。
- **LLM 题 mock 不生效**：本地 evaluator 镜像需包含新版 `noj_evaluator_sdk`，
  更新代码后重新构建 `noj-evaluator-python`。
