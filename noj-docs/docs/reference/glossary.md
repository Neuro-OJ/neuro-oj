# 术语表

本文档定义 Neuro OJ 文档与代码中的规范术语。每个词条给出定义、对应的代码字段名（如存在）以及"易混淆"提示。结果状态（`Accepted` / `WrongAnswer` 等）见[结果状态](result-status.md)。

## 项目名称

### Neuro OJ

Neuro OJ 是本项目的全称（英文 "Neuro" + "Online Judge"）。文档正文统一使用全称，不再使用 "NOJ" 简称；但代码、命令、队列名与协议标识（如 `noj-core`、`noj:judge:queue`、`__NOJ_RPC__`）仍保留原名。

## 评测核心

### 评测

一次提交从排队、执行题目评分逻辑到产生结果状态的完整过程。评测由 Judge Worker 执行，产物是一次评测结果。动词"评测"与名词"评测任务""评测结果"均建立在此概念上。

### 评测任务

（`JudgeTask`）

一条从 noj-core 经 Redis 队列分发给 Judge Worker 的消息，包含 `submission_id`、`problem_id`、`download_url`、`runtime_config`、`code` 等字段。

### 提交

（submission，`submissions` 表）

做题人针对一道题提交的一次代码记录。提交经评测后获得结果状态与分数。

::: warning 易混淆
提交（记录）≠ Solution（该代码在评测运行时的角色）。"提交"指整个记录，Solution 指其中代码在 Solution 容器中的执行身份。

:::
### 结果状态

（verdict，`submissions.status`）

一次提交的最终判定，如 `Accepted`、`WrongAnswer`、`TimeLimitExceeded`、`MemoryLimitExceeded`、`RuntimeError`、`SystemError`。各状态语义见[结果状态](result-status.md)。

### 调用

（call，`runner.call()`）

Neuro OJ 评分的基本单位：Evaluator 通过 `SolutionRunner` 对用户函数发起的一次 RPC 调用。与传统 OJ 的"测试点"对应，但语义不同——Neuro OJ 的用例数据格式由题目自定，评分以调用结果（返回值或调用错误）为准。

### Evaluator

出题人的评测程序（`evaluate.py`），运行在 Evaluator 容器中。它读取测试数据、调用用户函数、计算分数并输出结果。Evaluator 是评分逻辑的所有者。

::: warning 易混淆
Evaluator ≠ 评测（整个流程）≠ Judge Worker（执行评测的进程）。Evaluator 是运行在容器中的出题人代码。

:::
### Solution

用户提交的代码，运行在 Solution 容器中。

::: warning 易混淆
`solution` 在社区域另指**题解**（社区帖子类型，`type: "solution"`）。评测域中 Solution 指用户代码角色，社区域中 solution 指解题文章，二者同名不同义：评测任务字段 `runtime_config.solution` 指用户代码，社区帖子 `type: "solution"` 指题解。

:::
### Solution Host

Solution 容器中的协议进程，负责加载用户模块、接收 Evaluator 的函数调用请求、执行用户函数并返回结果或错误。

### 运行时配置

（`runtime_config`）

题目的双容器评测配置，包含 `evaluator` 与 `solution` 两段：evaluator 段指定 `image` 与 `command`，solution 段指定 `image` 与入口文件 `entry`，两段各自带时间限制（`time_limit_ms` / `call_timeout_ms`）与内存限制（`memory_limit_mb`）。manifest 中 `evaluator.command` 可缺省，导入时注入默认值 `python3 /workspace/evaluate.py`。

::: warning 易混淆
运行时配置 ≠ 资源限制。资源限制（时间/内存上限）是运行时配置中的一组字段，评测资源的实际控制还受 Judge Worker 执行环境（容器安全设置）影响。

:::
### Judge Worker

（`noj-judge` 进程）

负责从 Redis 获取评测任务、下载纯净评测包、运行 Docker 评测容器并回传结果的评测进程。

::: warning 易混淆
"Judge"是 Judge Worker 的简称，正文应避免单独使用（如"Judge 交付层"应写作"评测交付层"）；`noj-judge` 是仓库/模块名，指实现 Judge Worker 的 Rust 项目。

:::
### 评测镜像

（judge image，DB 表 `judge_images`）

运行 Evaluator 或 Solution 的 Docker 镜像，如 `noj-evaluator-python:3.12`、`noj-solution-python:3.12`。镜像是否可用由[镜像白名单](#judge-image-whitelist)（`judge_images` 表）决定。

::: warning 易混淆
评测镜像 ≠ 镜像白名单。评测镜像是具体镜像，镜像白名单是允许 Judge Worker 使用的评测镜像列表。

:::
### 镜像白名单 {#judge-image-whitelist}

（DB 表 `judge_images`，API 中称 judgeImages）

由 noj-core 管理的评测镜像许可列表，规定 Judge Worker 可以使用哪些 evaluator 和 solution 镜像。白名单条目包含 `image`（镜像名）、`kind`（`evaluator` / `solution`）、`mode`（版本匹配模式：`exact` / `all_versions`）。

## 题目与包

### 题型

（problem type，`problems.type`）

题目的归属类型：**U 型**（用户题，普通用户可创建，owner/admin 可管理）与 **P 型**（主题题，仅 admin 创建与管理）。题型决定题目的权限模型。

### 统一题目包

（Problem Bundle）

题目的导入载体：一个 zip，根层级包含 `problem.json`（manifest）、`statement.md`（可选）、`evaluate.py`、测试数据（可选）。通过 `import-bundle` 上传或 `noj problems import` 导入，创建或更新题目。

::: warning 易混淆
统一题目包 ≠ 纯净评测包。统一题目包是导入前的形态（含题面与元数据）；导入时系统剥离 `problem.json` / `statement.md` 等元数据后，得到纯净评测包。

:::
### 纯净评测包

（旧称"支持包"，代码字段 `support_package_storage_url`）

剥离元数据后的评测 zip：根层级包含 `evaluate.py`，可包含测试数据和辅助文件，不包含用户提交代码。以 `noj-storage://` URL 存入存储后端，由 Judge Worker 在评测任务中下载。文档中常简称为"评测包"。

::: warning 易混淆
文档旧称"支持包"。`support_package_storage_url` 字段与 UI 中的"题目支持包"区域仍沿用旧名，指的就是纯净评测包。若旧文档中的"支持包"指含元数据的导入载体，实为"统一题目包"。

:::
### 测试数据

（testcase）

`evaluate.py` 读取的评分输入材料。Neuro OJ 不规定格式；内置样例题使用 `visible.jsonl` / `hidden.jsonl` 约定，出题人可用 `cases/*.json`、SQLite、CSV 等任何方式组织。

::: warning 易混淆
测试数据 ≠ 用例。用例（case）是测试数据中的一个条目，按内置约定含 `id`、`input`、`expected`、`score` 等字段。

:::
### 用例

（case）

测试数据中的一个评分条目。内置样例题约定中，用例含 `id`（稳定 ID）、`input`（输入材料）、`expected`（标准结果或评分参考）等字段，可附 `score`（分值）、`tags`（分类）、`message`（对可见用例展示的说明）。用例分为可见用例与隐藏用例。

::: warning 易混淆
用例 ≠ 调用。用例是数据条目，调用（`runner.call()`）是 Evaluator 对用户函数的 RPC 请求；一个用例可能需要多次调用或一次调用来完成评分。

:::
### 可见用例

（visible case）

出题人愿意向做题人展示输入、期望与实际结果的用例。内置样例题约定存放于 `visible.jsonl`，但 Neuro OJ 不强制该文件名或数据格式。

::: warning 易混淆
可见用例 ≠ 样例。样例（sample）是题面中展示给用户的输入输出示例，通常取自可见用例，但"样例"强调展示性，"用例"是评分材料。

:::
### 隐藏用例

（hidden case）

出题人不希望直接暴露给做题人的评分用例。内置样例题约定存放于 `hidden.jsonl`，但 Neuro OJ 不强制该文件名或数据格式。出题人应避免向用户泄露隐藏输入和标准答案。

::: warning 易混淆
文档中的"隐藏测试""隐藏数据""评分材料"均指隐藏用例或其数据，应统一表述为"隐藏用例"。Solution 容器不应直接读取隐藏用例。

:::
### 样例

（sample）

题面中向做题人展示的输入输出示例，用于说明题意。

::: warning 易混淆
样例 ≠ 用例。样例用于说明题意，用例用于评分（可见用例或隐藏用例）。

:::
## 存储与交付

### `noj-storage://`

数据库存储层 URL，表示纯净评测包在本地存储或对象存储中的位置（字段 `support_package_storage_url`）。

### `noj-download://`

评测交付层 URL，表示本次评测任务如何下载纯净评测包（`JudgeTask.download_url`）。

::: warning 易混淆
两层 URL 分工不同：`noj-storage://` 标识资源在存储后端中的位置（持久），`noj-download://` 描述本次任务如何获取内容（交付）。同一个存储记录可以在 local、S3 等后端之间切换交付方式。

:::
## 社区

### 题解

（solution，社区帖子类型）

社区中用户发布的解题文章。帖子类型为 `solution`（另两种为 `discussion` 讨论、`moment` 短动态）。

::: warning 易混淆
与评测域的 **Solution**（用户提交的代码）同名。API 中二者均为 `solution`：评测任务字段 `runtime_config.solution` 指用户代码角色；社区帖子 `type: "solution"` 指题解。

:::
## 能力

### 能力

（capability）

Neuro OJ 面向大模型能力评测（LMCC）的评测对象。当前 Python 运行时中，用户以函数形式暴露能力，由 Evaluator 调用；`noj_solution_sdk.call_capability` 为预留的占位能力（当前不支持 Solution 到 Evaluator 的能力调用）。
