# 评测镜像与多语言

NOJ 的评测语言不是硬编码的：语言 → 运行时镜像 → 题目配置，三层解耦。本文说明如何添加一种新的评测语言或运行时。

## 当前支持的语言

提交接口按语言标识接受代码，当前已登记的语言标识：

| 语言标识 | 说明 |
|----------|------|
| `python3` / `python` | Python 3（唯一具备完整评测运行时的语言） |
| `cpp` / `c` / `javascript` | 标识已预留，暂无评测运行时 |

!!! warning "现状"
    评测运行时（双容器 Evaluator / Solution SDK）目前仅实现 Python；C++/C/JavaScript 的运行时为项目的**决策性不做**项（LMCC 仅 Python）。本文的「添加新语言」步骤即面向未来需要扩展运行时的情况。

题目可选的编程语言在编辑器/运行时配置中声明，做题人页面只会看到该题启用的语言。

## 三层模型

1. **语言标识**：提交时声明的 `language` 字段，决定提交文件名与运行时选择。
2. **运行时镜像**：Docker 镜像，分为 `evaluator`（跑出题人代码）与 `solution`（跑用户代码 + Solution Host）两类。
3. **题目配置**：题目的 `runtime_config` 指定 evaluator / solution 的镜像、命令与资源限制。

Judge Worker 只运行**白名单内**的镜像（`judgeImages` 表，含 `image` / `kind` / `mode` 匹配规则），启动时通过 Redis RPC 获取白名单并预热。

## Python 双容器是如何工作的

Python 题目使用两个镜像：

- `noj-evaluator-python`：运行出题人的 `evaluate.py`。
- `noj-solution-python`：运行用户提交的 `solution.py`，由 Solution Host 加载模块，把 stdout 重定向到 stderr（避免污染评测协议），并向 evaluator 暴露函数调用接口。

Evaluator 通过 [Evaluator SDK](evaluator-sdk.md) 调用用户函数，双方协议见 [RPC 与可传递数据](rpc.md)。

## 添加一种新语言（步骤）

以新增一个假设的 `ruby` 运行时为例：

1. **构建运行时镜像**：
   - 基于 `ruby:3-slim` 之类的基础镜像，加入 Solution Host 适配层（参照 `noj-judge/docker/solution-python/` 的 Dockerfile）。
   - Evaluator 镜像同样按需构建（`noj-judge/docker/evaluator-python/` 为参照）。
   - 构建脚本可参照 `noj-judge/scripts/build-sdk-images.sh`，tag 建议保持与白名单登记一致（默认 `:latest`）。

2. **登记白名单**：在管理后台「评测镜像」页添加 evaluator / solution 镜像名与匹配模式（或通过种子数据 / API 写入 `judgeImages`）。

3. **重启 Judge Worker**：使其重新拉取白名单并预热新镜像；镜像不存在或未登记会导致提交直接 `SystemError`。

4. **配置题目**：在[题目编辑器](web-editor.md)的运行时配置中，为该题选择新语言的 evaluator / solution 镜像，并设置命令与资源限制。

5. **自测**：用参考答案提交一次，确认调用协议（函数加载、返回值、异常映射）与状态判定符合预期。

!!! warning "安全要求"
    新语言运行时必须满足沙箱约束：镜像内不依赖宿主网络（评测时 `network_mode none`）、不携带特权能力；容器侧的安全配置由 Judge Worker 统一强制，镜像不应尝试绕过。

## 常见问题

- **提交显示 `SystemError`**：优先检查镜像是否已构建、是否在白名单中、题目 `runtime_config` 的镜像名是否与白名单一致。
- **语言选项不出现**：该题未启用该语言——在题目的运行时配置中补充。
- **函数调用协议不兼容**：不同语言的 Solution Host 适配不同，务必参照 Python 的[Solution SDK](solution-sdk.md) 实现等价行为（模块加载、stdout 重定向、异常序列化）。
