## Why

生产部署目前只有 PostgreSQL 单文件备份提示，Redis、MinIO 支持包和生产密钥没有统一的备份、校验与恢复路径。#326 需要在正式上线前建立可重复的快照和恢复演练入口，降低迁移失败、主机故障或对象存储损坏造成的不可逆数据损失。

## What Changes

- 新增生产备份工具，统一导出 PostgreSQL、Redis、MinIO bucket 和加密的 `.env.prod`。
- 为每次备份生成不含密钥的清单、校验和、数据库迁移状态及保留期限信息。
- 新增备份完整性校验、数据恢复和恢复演练命令，恢复操作要求显式确认并保护现有生产数据。
- 在标准生产升级流程拉取新镜像和启动迁移前，自动创建并验证备份；备份失败则阻止升级。
- 增加备份失败、空间不足、校验失败和恢复失败的非零退出码与可接入告警的错误输出。
- 更新生产配置模板、部署文档和 Runbook，明确 RPO/RTO、Redis 队列数据的可丢失性、PostgreSQL 增量/PITR 的基础设施边界和定期恢复演练方式。

## Capabilities

### New Capabilities

- `production-backup-recovery`: 生产数据与密钥的备份、校验、恢复及恢复演练流程。

### Modified Capabilities

- `production-release-pipeline`: 生产升级必须先完成可验证备份，且文档需要提供备份与恢复前置条件。

## Impact

- 修改 `scripts/deploy/deploy.sh`，增加备份参数并将升级前置备份接入标准流程。
- 新增 `scripts/deploy/backup.sh` 及无真实生产资源的回归测试。
- 复用生产 Docker Compose 中的 PostgreSQL、Redis、MinIO 服务和持久化卷，不改变业务 API。
- 新增 GPG 加密备份所需的宿主机 passphrase 文件配置；不在仓库或普通日志中保存明文密钥。
- 更新 `.env.prod.example`、`scripts/README.md` 和生产部署文档。
