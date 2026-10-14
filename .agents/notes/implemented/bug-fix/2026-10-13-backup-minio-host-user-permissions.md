# Agent Note: MinIO 备份容器使用暂存目录的宿主身份

Status: implemented

## Problem

Bitnami mc 镜像默认 UID 为 1001，CLI 当前宿主用户为 1000。备份暂存目录由 CLI
创建，外层权限保持 0700，MinIO
子目录为宿主用户所有；容器默认用户无法写入该挂载。

真实只读 S3 采集复现中，`mc mirror` 输出传输了 5.86 KiB、退出码为
0，但目标目录没有文件；同一镜像执行 `mc cp` 明确返回路径权限不足。仅依赖 mirror
的退出码会错误地接受没有版本对象的备份。

## Decision

MinIO 镜像命令显式使用 `--user <Deno.uid()>:<Deno.gid()>`，与 CLI
创建的暂存目录属主一致，并设置
`MC_CONFIG_DIR=/tmp/noj-backup-mc`，让该身份可以写入临时 mc 别名配置。

保留完整 Compose 上下文，不放宽暂存目录权限。针对性参数测试核对用户身份及 mc
配置位置。标准 `deno task test --filter=T17` 实际通过 25 项、0
项失败；格式、lint 和类型检查通过。

真实容器使用该身份后，原源桶的 9 个对象全部写入宿主目录。随后标准 CLI
成功创建加密 `.nojbackup`，并通过 `backup verify --deep`；数据库、Redis
及对象的隔离恢复业务验收单独记录。

## Alternatives considered

- 将目录改为全员可写：暴露敏感备份暂存数据，也让成功依赖进程 umask。
- 始终以 root 运行 mc：创建 root
  所有的暂存文件，限制普通操作者清理，且没有必要增加权限。
- 接受 mirror 退出码或空目录：真实复现证明这会遗漏已有版本字节。

## Consequences

采集文件归 CLI 操作者所有，宿主目录继续使用既有私有权限。部署 CLI 面向 Linux
amd64，UID/GID 来自该运行平台；本修复不新增 Windows 生产部署或 local
卷备份协议。
