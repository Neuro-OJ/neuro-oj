## MODIFIED Requirements

### Requirement: 公测部署文档

系统 SHALL 将公测部署流程写入 `noj-docs/docs/operators/production-deploy.md`，至少包含：

- 前置条件（Docker、域名、外部 TLS 终止、ghcr 访问）。
- 初始化步骤：复制 `.env.prod.example` → 填写配置 → 运行 `migrate` → 启动服务。
- 评测镜像白名单更新：将 `judge_images` 中的镜像更新为 ghcr 全限定名。
- 日常运维：查看状态、日志、健康检查。
- 升级与回滚：修改 `NOJ_VERSION` 重新部署；数据库迁移不回滚的注意事项。
- 备份与恢复：PostgreSQL、Redis、MinIO/S3 和加密环境文件的备份、校验、恢复与定期演练；说明 RPO/RTO 和 Redis 队列数据的可丢失性。

系统 SHALL 移除 noj-docs 中旧的开发期部署方法（`local-start.md` 及 `devtool.sh` 部署描述），
并将运营者文档侧边栏的“本地启动”替换为“生产部署”。

#### Scenario: 按文档完成公测部署

- **WHEN** 运维按 `noj-docs/docs/operators/production-deploy.md` 操作
- **THEN** 可完成从空服务器到可访问 HTTPS 公测站点的部署
- **THEN** 文档包含评测镜像白名单更新步骤，避免 judge 因镜像不在白名单而拒绝任务

#### Scenario: 运营者文档不再展示旧开发期部署

- **WHEN** 用户打开 noj-docs 运营者文档
- **THEN** 侧边栏显示“生产部署”而不是“本地启动”
- **THEN** 不再出现“开发期部署与运维方式尚未成熟”的警示块

#### Scenario: 升级前完成备份与恢复准备

- **WHEN** 运维按文档执行生产升级
- **THEN** 文档要求先执行可验证的全量备份，并说明备份失败时不得启动迁移
- **THEN** 文档提供恢复校验、显式确认和定期恢复演练命令
