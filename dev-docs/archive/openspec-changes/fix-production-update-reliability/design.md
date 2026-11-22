## Context

`noj update` 先调用当前安装目录中的 bootstrap 同步目标 Release，再调用生产升级脚本。现有实现会在同步期间修改正在执行的脚本目录；同时，首次安装配置只生成应用密钥，没有为升级备份准备口令文件。真实生产验证还暴露了 PostgreSQL dump 校验参数和 Nginx 上游地址缓存问题。

## Goals

- 让首次安装、固定版本升级和更新失败都具有明确、可恢复的状态。
- 让已有安装的文件同步不被自身运行状态阻断。
- 保证升级前备份真正完成并可校验，升级后外部入口可用。
- 不把备份口令写入 `.env.prod`、日志、镜像或 Git。

## Non-Goals

- 不绕过升级前备份门禁。
- 不自动回滚已经执行的数据库迁移。
- 不在本变更中修改业务容器或应用代码。

## Decisions

### 已有安装的端口检查

`install.sh --files-only` 只同步部署文件，不启动服务，因此跳过宿主机端口占用检查；首次安装仍执行端口检查。生产 `deploy.sh` 的端口检查继续保留提示，但不得把当前 Compose 栈自身的监听视为阻断。

### 备份口令

安装时默认使用 `/etc/noj/backup-passphrase`。如果路径已由 `NOJ_BACKUP_PASSPHRASE_FILE` 指定，则使用指定路径；已存在且权限为 `600` 或 `400` 的文件不覆盖。创建失败时在任何服务启动前返回明确错误。配置只保存路径，口令由 `openssl rand` 生成并以受限权限写入。

### PostgreSQL dump 校验

`pg_restore --list` 通过 `docker compose exec -T postgres` 执行，dump 从宿主机重定向到容器标准输入，不传递 `-` 或宿主机路径作为容器内文件名。

### Nginx 刷新

Compose 完成应用服务健康检查后，使用 `up -d --force-recreate --no-deps nginx` 刷新反向代理容器，使其重新解析 `core` 和 `ui` 的容器地址；不重建数据库、Redis 或应用容器。

### Bootstrap 同步

文件同步模式只复制目标 Release 的部署文件并注册命令，不调用目标安装流程。同步成功后由当前 `noj` 继续调用当前目录的 `deploy.sh upgrade`，避免执行被替换中的脚本。

## Risks and Mitigations

- 自动创建的口令丢失会影响备份恢复：安装完成时明确打印路径和保存提醒，并在文档中说明。
- `/etc/noj` 不可写：安装在服务启动前失败并给出显式路径配置方案。
- Nginx 重建失败：升级返回非零并保留完整备份，提示执行状态与日志检查。
- Release tag 不存在：下载失败提示不可变标签格式和实际 Release 链接，不修改目标版本配置。
