# 评测镜像与运行时

Neuro OJ 的评测通过 Docker 镜像承载：出题人代码（evaluator）与用户代码（solution）分别运行在独立镜像的容器中。本文说明镜像白名单机制、Python 双容器运行时、产物提交运行时与常见问题。

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

镜像由 `noj-judge/scripts/build-sdk-images.sh` 构建（默认 tag `:latest`，与 noj-core 种子数据 `judge_images` 登记一致）。

Evaluator 通过 [Evaluator SDK](evaluator-sdk.md) 调用用户函数，双方协议见 [RPC 与可传递数据](rpc.md)。

## 常见问题

- **提交显示 `SystemError`**：优先检查镜像是否已构建（`build-sdk-images.sh`）、是否在白名单中、题目 `runtime_config` 的镜像名是否与白名单一致。
- **语言选项不出现**：该题未在运行时配置中启用该语言——但请注意当前仅 Python 可用，其他标识无法评测。
