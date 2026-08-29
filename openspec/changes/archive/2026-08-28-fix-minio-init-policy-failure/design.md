## Context

生产 Compose 使用精简的 `minio/mc` 镜像执行 bucket 和 policy 初始化。该镜像没有 `sed`，而现有脚本在初始化命令失败后仍可能执行到 `exit 0`，掩盖策略未创建的问题。

## Goals / Non-Goals

**Goals:**

- 让初始化脚本只依赖镜像内已有的 shell 和基础命令。
- 让任一初始化失败都可靠地传递为非零退出码。
- 用真实 MinIO 运行验证应用凭据的目标 bucket、跨 bucket 和管理权限边界。

**Non-Goals:**

- 不改变应用 policy 的权限集合。
- 不改变 core 的 StorageProvider API 或 S3 客户端实现。
- 不引入新的运行时镜像或外部工具依赖。

## Decisions

1. 使用 `/bin/sh` 参数展开替换 `__S3_BUCKET__`，并通过 `cat`/`printf` 写出 policy 文件。该方式适配当前精简镜像；相比增加工具或更换镜像，供应链和维护面更小。
2. 在初始化命令开头启用 `set -eu`。已有的“允许删除旧 policy 失败”例外继续使用显式 `|| true`，其他 bucket、用户和 policy 操作必须直接失败。
3. 保留 `minio-init` 的 `service_completed_successfully` 依赖，并用一次真实 app alias 的读写与拒绝操作验证失败闭环。

## Risks / Trade-offs

- [Risk] shell 参数替换依赖 ash/bash 风格扩展 → 已在目标 `minio/mc` 镜像中验证 `${value//pattern/replacement}` 可用。
- [Risk] policy 重建会短暂影响旧应用用户 → Runbook 在重启 core 前完成新凭据验证，且初始化失败会阻止继续部署。
