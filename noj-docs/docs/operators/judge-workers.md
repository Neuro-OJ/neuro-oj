# Judge Worker 运维

## Worker 职责

`noj-judge` 从 Redis 队列拉取评测任务，下载支持包，创建或复用 Docker 容器，运行 evaluator，并把结果写回 Redis。

## 双容器运行时

默认 Python 题目使用两个镜像：

- `noj-evaluator-python:3.12`：运行出题人的 `evaluate.py`。
- `noj-solution-python:3.12`：运行用户提交的 `solution.py` 和 Solution Host。

Evaluator 容器可以通过 NOJ Evaluator SDK 调用 Solution 容器中的用户函数。

## 镜像白名单

noj-core 维护评测镜像白名单。Judge Worker 启动时会通过 Redis RPC 获取白名单，并只预热和使用允许的镜像。

镜像规则包含：

- `image`：镜像名。
- `role`：`evaluator` 或 `solution`。
- `mode`：版本匹配模式。

## 容器池

Judge Worker 使用容器池预热 evaluator 和 solution 容器。空闲容器会被复用；任务完成后池会回补容器。这样可以降低每次提交的冷启动成本。

## 常见排查方向

- Redis 连接失败：检查 Redis 地址和服务状态。
- Docker 连接失败：确认 Docker daemon 可用，当前用户有权限访问。
- 镜像不存在：先构建或拉取 `noj-evaluator-python:3.12` 与 `noj-solution-python:3.12`。
- 白名单为空：确认 noj-core 已启动、seed 已执行，且 Judge Worker 能通过 Redis RPC 请求到白名单。
- `SystemError`：通常是支持包、运行时配置、镜像、协议或 evaluator 本身异常，需要查看 Judge Worker 日志。
