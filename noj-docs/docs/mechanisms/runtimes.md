# 评测镜像与运行时

Neuro OJ 的评测通过 Docker 镜像承载：出题人代码（evaluator）与用户代码（solution）分别运行在独立镜像的容器中。本文说明镜像白名单机制、Python 双容器运行时、产物提交运行时、prediction 单容器运行时与常见问题。

::: warning 现状
当前评测运行时**仅实现 Python**（双容器 Evaluator / Solution SDK 均为 Python 实现，支持包模板固定 `python3`）。多语言评测（C++/Java/JavaScript 等）是项目的**决策性不做**项——LMCC 仅要求 Python，项目不会提供其他语言的评测运行时。
:::

## 运行时选择

提交接口按语言标识接受代码，当前已登记的语言标识：

| 语言标识 | 说明 |
|----------|------|
| `python3` / `python` | Python 3（唯一具备完整评测运行时的语言） |
| `cpp` / `c` / `javascript` | 接口预留标识，**无评测运行时，不可提交评测** |

题目可选的编程语言由出题人在运行时配置中声明，做题人页面只会看到该题启用的语言。

## 运行时选择的三层模型

1. **语言标识**：提交时声明的 `language` 字段，决定提交文件名（当前固定映射为 `main.py`）。
2. **运行时镜像**：Docker 镜像，分为 `evaluator`（跑出题人代码）与 `solution`（跑用户代码 + Solution Host）两类。
3. **题目配置**：题目的 `runtime_config` 指定 evaluator / solution 的镜像、命令与资源限制。

Judge Worker 只运行**白名单内**的镜像（`judgeImages` 表，含 `image` / `kind` / `mode` 匹配规则）；白名单校验在 noj-core 侧完成，judge 侧用 `JUDGE_IMAGE_PREFIX` 前缀白名单对 MQ 消息做纵深复验。

## Python 双容器是如何工作的

Python 题目使用两个镜像：

- `noj-evaluator-python`：运行出题人的 `evaluate.py`。
- `noj-solution-python`：运行用户提交的代码（Judge Worker 以硬编码名 `main.py` 注入），由 Solution Host 加载模块，并向 evaluator 暴露函数调用接口。Solution stdout 是协议通道，用户代码的普通 `print()` 文本会被协议层丢弃。

产物提交题使用 zip 文件作为提交物。需要 CPU PyTorch、CV/ML 依赖的题目可以选择
`noj-solution-ai`；Judge Worker 会将产物解压到 Solution 容器的 `/workspace`，由约定的
`submission.py` 入口加载。产物提交不支持重测，具体大小上限由题目配置和系统硬上限共同决定。

## prediction 单容器运行时

**预测提交（prediction）题**是唯一**不创建 Solution 容器**的路径。选手提交的是单个预测数据文件（纯数据，不是代码），平台不执行任何不可信代码，因此只需一个 Evaluator 容器：

- 只创建 `noj-evaluator-python` 容器（`cap_drop ALL` / 默认无网 / `pids_limit` / CPU 上限 / readonly rootfs + tmpfs `/workspace`），**绝不创建 Solution 容器**，也没有 NDJSON 编排。
- 支持包 zip 注入 Evaluator `/workspace`（`evaluate.py` + 隐藏标签）。
- 预测文件以**流式注入**写入 `/workspace/prediction/<原始文件名>`，该目录下只有这一个文件。
- Judge Worker 向 Evaluator exec 注入两个环境变量：

  | 环境变量 | 值 | 说明 |
  |----------|-----|------|
  | `NOJ_PREDICTION_DIR` | `/workspace/prediction` | 预测文件所在目录 |
  | `NOJ_PREDICTION_FILE` | 选手上传的文件名 | 预测文件名 |

- `/workspace` 大小由 `runtime_config.evaluator.workspace_size_mb` 决定；缺省取 Judge Worker 的 `JUDGE_PREDICTION_WORKSPACE_MB`（默认 `2048`，单位 MB）。两者都被收敛到 **512–16384** 范围（题目级越界值在 judge 侧 clamp）；管理员可用 `judge_max_prediction_workspace_mb` 设置项（`JUDGE_MAX_PREDICTION_WORKSPACE_MB`，0 = 不限制）再收一层上限，超限的出题请求在保存时即 400。大预测文件会以 tmpfs 形式占用 Worker 内存。
- 输出解析与双容器一致：Evaluator stdout 出现 `---RESULT---` 后取下一非空行 JSON `{score, details}`；stdout/stderr 全文受 1 MiB 硬上限约束，标记检测为流式（不依赖滚动缓冲重扫）。
- prediction 题**不配置 `solution`**：题目的 `runtime_config` 可省略 `solution`，提交时语言固定为 `python3` 占位。
- 预测文件复用 `artifact_storage_url` 生命周期：评测完成后对象即删除，**不支持重测**。

出题约定见[出预测提交题](../problemsetters/prediction-problems.md)。

镜像由 `noj-judge/scripts/build-sdk-images.sh` 构建（默认 tag `:latest`，与 noj-core 种子数据 `judge_images` 登记一致）。

Evaluator 通过 [Evaluator SDK](evaluator-sdk.md) 调用用户函数，双方协议见 [RPC 与可传递数据](rpc.md)。

## 常见问题

- **提交显示 `error`**：优先检查镜像是否已构建（`build-sdk-images.sh`）、是否在白名单中、题目 `runtime_config` 的镜像名是否与白名单一致。
- **语言选项不出现**：该题未在运行时配置中启用该语言——但请注意当前仅 Python 可用，其他标识无法评测。
