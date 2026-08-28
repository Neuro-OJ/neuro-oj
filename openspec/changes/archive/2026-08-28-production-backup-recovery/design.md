## Context

当前 `scripts/deploy/deploy.sh backup` 只通过 PostgreSQL 容器生成 custom-format dump；生产 Compose 的 Redis AOF、MinIO 持久卷和 `.env.prod` 尚无统一导出与恢复方式。数据服务都由同一套 Docker Compose 管理，因此备份工具可以复用服务容器内的客户端，避免要求宿主机安装多套数据库工具。

## Goals / Non-Goals

**Goals:**

- 用一个受控的快照目录保存 PostgreSQL、Redis、MinIO/S3 和加密环境文件。
- 在快照完成时生成校验清单、迁移状态、版本信息和不含密钥的审计元数据。
- 提供 `create`、`verify`、`restore` 和 `drill` 命令，并让标准 `upgrade` 在迁移前自动执行 `create + verify`。
- 对恢复和过期快照清理设置显式安全边界，失败通过非零退出码传播。

**Non-Goals:**

- 不在仓库内实现云厂商的异地复制、密钥管理服务或定时器；部署者可用 cron/systemd timer/托管备份服务调度脚本。
- 不把 PostgreSQL 逻辑 dump 宣称为增量/PITR。当前实现提供完整逻辑快照；低于快照间隔的 RPO 需要 PostgreSQL WAL 归档或托管数据库能力。
- 不把 Redis 队列当作长期业务数据；恢复 Redis 可能重新出现旧任务，Runbook 要求按业务情况清理或重建队列。

## Decisions

### 1. 使用目录快照而不是单一归档文件

每次备份写入 `snapshot-YYYYMMDD-HHMMSS/`，内含 `postgres.dump`、`postgres-globals.sql`、`redis.rdb`、`minio/`、`env.prod.gpg`、`manifest.json` 和 `sha256sums.txt`。目录结构便于检查单个组件、断点诊断和对象存储增量 mirror；目录与文件均使用属主可读权限。

### 2. 通过 Compose 服务执行数据导出

- PostgreSQL 使用容器内 `pg_dump -Fc` 和 `pg_dumpall --globals-only`，完成后通过容器内 `pg_restore --list` 检查 dump 结构。
- Redis 使用认证后的 `redis-cli --rdb` 导出一致性快照，并记录 persistence 信息。Redis 已启用 AOF，但 RDB 是可搬运的恢复载体。
- MinIO 使用一次性 `minio/mc` 客户端容器执行 `mc mirror --preserve`，仅同步 bucket 对象，不把 root 凭据写入报告。

这样与生产 Compose 的服务版本保持一致，也避免在宿主机暴露数据库端口。

### 3. 使用 GPG 对环境文件加密

备份命令强制要求宿主机上的 passphrase 文件，文件权限必须为 600 或 400；使用 GPG 对 `.env.prod` 做 AES-256 对称加密，并在校验阶段解密到临时文件后立即删除。口令不允许通过命令行参数、环境变量、日志或 manifest 传递。若部署者已有 secrets manager，可不使用环境文件恢复，但仍必须满足备份工具的显式加密配置。

### 4. 恢复默认拒绝覆盖

`restore` 要求 `--confirm`，并检查 Compose 没有运行中的服务；Redis 恢复会先停止 Redis 并替换快照，MinIO 恢复使用 `mc mirror --overwrite --remove`。生产恢复前应先把快照复制到隔离环境执行 `drill`，`down -v` 永不由工具自动调用。

### 5. 升级前备份只接入标准升级入口

`deploy.sh upgrade` 在 `pull` 和包含迁移的 `up` 之前调用备份工具并验证结果。首次安装的空数据库不强制创建快照；手工直接运行 Compose 的操作者必须遵守文档中的“备份 → migrate → up”顺序。这样不改变现有 Compose 服务定义，也不会在容器启动后才发现无法回滚。

## Risks / Trade-offs

- [PostgreSQL 逻辑快照不是连续增量] → 文档明确快照 RPO，并为需要更低 RPO 的部署保留 WAL/PITR 或托管数据库接入点。
- [Redis 恢复可能重新提交旧评测任务] → 文档标识队列为瞬时数据，恢复后由运维检查并按需清理 `noj:judge:queue` 与 processing 队列。
- [MinIO mirror 依赖临时容器访问生产网络] → 复用 Compose 网络和已配置的服务凭据；mirror 失败即返回非零，不生成成功标记。
- [加密口令文件丢失会导致环境文件不可恢复] → 口令文件由 secrets manager 或受控主机备份管理，脚本只检查权限，不复制口令文件。
- [恢复和清理具有破坏性] → 恢复必须 `--confirm` 且目标服务必须停止；过期清理限制在明确的备份根目录和 `snapshot-*` 名称。

## Migration Plan

1. 为现有生产部署准备受保护的 GPG passphrase 文件，并按模板配置备份目录、保留期限和 RPO/RTO。
2. 先执行 `backup.sh create` 和 `backup.sh verify`，确认 PostgreSQL、Redis、MinIO 和环境文件均有产物。
3. 在隔离 staging 环境执行一次 `backup.sh drill`/恢复演练，记录结果后再使用新的 `deploy.sh upgrade`。
4. 回滚应用版本时仍使用原有 `NOJ_VERSION` 回滚流程；若数据库迁移不可逆，必须先恢复兼容快照，不自动回滚 schema。
