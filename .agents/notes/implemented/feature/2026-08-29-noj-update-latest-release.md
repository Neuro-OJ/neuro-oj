# Agent Note: 为生产 CLI 增加最新稳定版本升级

Status: implemented

## Problem

已有生产安装只能通过手动修改 `.env.prod` 的 `NOJ_VERSION` 升级，容易遗漏最新版本；直接使用可变的 `latest` 镜像标签又会削弱版本追溯、签名校验和回滚能力。

## Decision

增加显式命令 `noj update --latest`，通过 GitHub latest Release API 查询最新的非草稿、非预发布 Release。命令先展示目标版本，使用临时生产配置执行现有的部署文件同步、备份、镜像签名校验、Compose 升级和健康检查，只有升级成功才提交新的 `NOJ_VERSION`。当前已经是最新版本时成功无操作；固定版本的 `noj update` 继续保留，用于 RC、复现和回滚。

## Alternatives considered

- 让所有 `noj update` 默认自动升级：操作简单，但会破坏固定版本可追溯性，并可能使定时任务意外升级。
- 直接把 Compose 镜像改为 `latest`：实现最简单，但可变标签无法可靠关联源码、签名和部署文件，也不利于回滚。
- 增加后台定时自动更新：减少人工操作，但需要处理停机窗口、数据库迁移、失败告警和回滚授权，超出当前生产运维入口的安全边界。

## Consequences

运维人员可以使用 `noj update --latest` 主动升级到最新稳定 Release，重复执行不会无意义地重启服务。升级查询依赖 GitHub API；网络不可用、Release 无效、镜像签名或健康检查失败时会中止并保留原版本配置。RC/预发布版本仍需显式固定 `NOJ_VERSION`。
