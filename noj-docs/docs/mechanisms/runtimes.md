# 评测镜像与运行时

> 一句话：评测只跑 **Python**——出题人代码（evaluator）与用户代码（solution）各用一个 Docker 镜像，分别运行在独立的 Evaluator 容器与 Solution 容器中。

Neuro OJ 的评测通过 Docker 镜像承载：出题人代码（evaluator）与用户代码（solution）分别运行在独立镜像的容器中。本文说明镜像白名单机制、Python 双容器运行时、产物提交运行时与常见问题。

::: warning 现状：评测运行时仅实现 Python
当前双容器 Evaluator / Solution SDK 均为 Python 实现；前端返回的**初始代码模板语言也固定为 `python3`**（`GET /problems/:id/template` 返回的 `language` 字段），这与支持包无关。多语言评测（C++/Java/JavaScript 等）是项目的**决策性不做**项——LMCC 仅要求 Python，项目不会提供其他语言的评测运行时。
:::

## 运行时选择

提交接口按语言标识接受代码，当前已登记的语言标识（服务端 `LANGUAGE_EXT_MAP`）：

| 语言标识 | 默认文件名 | 是否可评测 |
|----------|-----------|-----------|
| `python3` / `python` | `main.py` | ✅ 唯一具备完整评测运行时的语言 |
| `cpp` / `c` / `javascript` | `main.cpp` / `main.c` / `main.js` | ❌ 接口预留标识，无评测运行时，不可提交评测 |

::: info `language` 只用于校验与默认命名
`language` 是提交元数据：服务端据此校验是否受支持，并推导提交文件的默认名。**Judge Worker 注入 Solution 容器时统一使用硬编码入口名 `main.py`**，不读取 `language` 或提交文件名来选择运行方式。
:::

当前前端编辑器与题目详情页固定只提供 **Python 3**；提交记录筛选器仍列出其他预留标识，仅用于查看历史，不代表可评测。

## 运行时选择的三层模型

1. **语言标识**：提交时声明的 `language` 字段，用于校验与默认文件名推导（见上）。
2. **运行时镜像**：Docker 镜像，分为 `evaluator`（跑出题人代码）与 `solution`（跑用户代码与容器内 host 进程）两类。
3. **题目配置**：题目的 `runtime_config` 指定 evaluator / solution 的镜像与资源限制，evaluator 另有 `command`（缺省 `python3 /workspace/evaluate.py`）。

Judge Worker 只运行**白名单内**的镜像（`judge_images` 表，含 `image` / `kind` / `mode` 匹配规则）；白名单校验在 noj-core 侧完成，judge 侧用 `JUDGE_IMAGE_PREFIX` 前缀白名单对 MQ 消息做纵深复验。

## Python 双容器是如何工作的

Python 题目使用两个镜像：

- `noj-evaluator-python`：运行出题人的 `evaluate.py`。
- `noj-solution-python`：运行用户提交的代码（Judge Worker 以硬编码名 `main.py` 注入），由 `noj_solution_sdk.host` 加载模块，并向 evaluator 暴露函数调用接口。Solution stdout 是协议通道，用户代码的普通 `print()` 文本会被协议层丢弃。

产物提交题使用 zip 文件作为提交物。需要 CPU PyTorch、CV/ML 依赖的题目可以选择
`noj-solution-ai`；Judge Worker 会将产物解压到 Solution 容器的 `/workspace`，由约定的
`submission.py` 入口加载。产物提交不支持重测，具体大小上限由题目配置和系统硬上限共同决定。

::: tip 镜像从哪来
镜像由 `noj-judge/scripts/build-sdk-images.sh` 构建，默认 tag `:latest`，与 noj-core 种子数据 `judge_images` 登记的裸镜像名（Docker 解析为 `:latest`）一致。
:::

Evaluator 通过 [Evaluator SDK](evaluator-sdk.md) 调用用户函数，双方协议见 [RPC 与可传递数据](rpc.md)。

## 常见问题

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 提交显示 `error` | 镜像未构建、不在白名单、或题目 `runtime_config` 的镜像名与白名单不一致 | 检查 `build-sdk-images.sh` 是否执行、`judge_images` 是否登记该镜像、题目配置是否一致 |
| 语言选项不出现 | 前端固定只提供 Python 3 | 其他语言标识无法评测，请使用 Python 提交 |
