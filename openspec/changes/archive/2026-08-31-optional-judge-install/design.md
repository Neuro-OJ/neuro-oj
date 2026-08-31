## Context

生产 Compose 当前把 Judge 作为默认服务，并通过 Compose 变量强制要求专用 Docker socket。生产部署脚本也在所有生命周期命令中校验该 socket。NOJ 的 core 只依赖 Redis 消费结果，不需要 Judge 容器才能提供网站和 API。

## Goals / Non-Goals

**Goals:**

- 让新用户在配置向导中选择是否部署本机 Judge。
- 跳过 Judge 时只启动基础网站服务，不因 socket 缺失失败。
- 保持已有安装默认行为和随时重新启用 Judge 的能力。

**Non-Goals:**

- 不把应用宿主机 Docker socket 交给 Judge。
- 不实现远程 Judge 自动发现或多节点编排；独立 Judge 仍由现有脚本单独安装和连接。
- 不删除 Judge 配置字段或改变评测队列协议。

## Decisions

- 新增 `JUDGE_ENABLED`，`false` 表示跳过 Judge，其他值和缺失值默认视为启用。缺失值默认启用是为了兼容已有 `.env.prod`。
- 在 Compose 的 `judge` 服务上使用 `profiles: [judge]`。部署脚本根据 `JUDGE_ENABLED` 给每个 Compose 操作追加 `--profile judge`；这样 `up`、`pull`、`config` 和 `stop` 的行为一致。
- Judge 服务的 socket 和 GID 插值改为带默认值，避免 Compose 在未启用 profile 时因缺少变量而无法解析；启用 Judge 时部署脚本仍强制检查真实的独立 socket，并拒绝共享 socket。
- 镜像签名校验在 Judge 关闭时跳过 Judge Worker 和 evaluator/solution 运行时镜像，仅校验实际部署的 core、ui 和 LLM Gateway 镜像；启用时恢复完整校验。
- 配置向导在邮件配置之后询问“是否同时安装评测服务 Judge”。选择否只写入 `JUDGE_ENABLED=false`，保留旧 socket 值以便稍后重新启用；选择是继续询问 socket。
- 生产安装完成提示根据选择说明评测是否可用，并提供修改 `JUDGE_ENABLED` 后重新执行 `start` 的后续路径。

## Risks / Trade-offs

- [跳过 Judge 后提交的代码不会评测] → 安装结果明确提示评测未启用，并在状态/文档中说明如何启用。
- [Compose profile 和环境变量行为复杂] → 为 `config`、`pull`、`up`、`stop` 和签名校验增加回归测试，并保持旧配置默认启用。
- [用户选择启用但 socket 不存在] → 继续在启动前 fail-fast，给出专用 rootless Docker socket 的修复提示。

## Migration Plan

1. 新安装由配置向导写入 `JUDGE_ENABLED=true/false`。
2. 已有 `.env.prod` 缺少该字段时按 `true` 处理，升级不改变现有 Judge 服务。
3. 需要后续启用时，将 `JUDGE_ENABLED=true`、专用 socket 和 GID 写入配置，再执行 `bash scripts/deploy/deploy.sh start`。
