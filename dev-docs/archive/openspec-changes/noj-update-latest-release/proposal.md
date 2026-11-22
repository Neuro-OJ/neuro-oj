## Why

现有生产升级要求运维人员手动修改 `.env.prod` 中的 `NOJ_VERSION`，容易遗漏最新可用版本，也让升级流程与首次安装的 Release 查询能力不一致。需要提供一个显式、可审计且保留固定版本回滚能力的自动升级入口。

## What Changes

- 为生产 `noj update` 增加 `--latest` 选项，查询仓库最新的非草稿、非预发布 Release。
- 在执行升级前展示目标版本，并将 `.env.prod` 的 `NOJ_VERSION` 更新为该版本。
- 复用现有的部署文件同步、备份、镜像签名校验、拉取和健康检查流程。
- 网络查询失败或目标 Release 不满足稳定版本条件时，保持当前配置和服务不变并返回失败；已是最新版本时报告无需升级并成功退出。
- 保留不带 `--latest` 时按固定 `NOJ_VERSION` 升级的行为，支持 RC/固定版本回滚。
- 更新生产部署文档和 CLI 帮助，并增加无 Docker 的自动版本查询测试。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `openspec/specs/production-deployment/spec.md`: 生产升级入口增加显式获取最新稳定 Release 的能力，并要求失败时不改变生产版本配置。

## Impact

- 修改仓库根目录 `noj` 生产运维 CLI。
- 修改 `scripts/deploy` 相关测试和生产部署文档。
- 运行时新增对 GitHub Releases API 的 HTTPS 查询；不新增运行时依赖。
- 不修改 Docker Compose 数据卷、数据库 Schema 或镜像发布流程。
