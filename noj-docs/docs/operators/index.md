# 运营与部署文档中心

本指南面向私有化部署、系统管理员及赛事技术运维人员，覆盖从系统首次上线部署、算力调度扩容、安全凭据轮换到日常管理运营的完整技术路径。

::: tip 生产部署核心工具：noj-cli
Neuro OJ 生产环境统一采用纯 TypeScript 编写的单二进制运维工具 **noj-cli** 进行全生命周期管理（安装、启停、无缝更新、备份、验证）。请首选阅读 [生产部署指南](./production-deploy.md)。
:::

---

## 🚀 运维知识导航

### 1. 安装、初始化与日常维护
- [生产部署指南 (noj-cli)](./production-deploy.md)：基于 Docker Compose 与官方容器镜像的一键安装、`.env.prod` 核心配置、平滑更新与备份恢复。
- [CLI 运维工具与命令](./cli.md)：服务管理、数据库迁移、系统初始化、管理员凭据引导等常用 CLI 命令清单。
- [生产密钥管理与轮换 Runbook](./production-secrets.md)：JWT Secret、数据库密码、Redis、MinIO 与 SMTP 凭据的无停机轮换与应急回滚步骤。

### 2. 核心组件与算力运维
- [Judge Worker 评测机运维与水平扩展](./judge-workers.md)：沙箱环境依赖（Docker）、评测镜像预热、Redis 队列监控与 Worker 多节点水平扩展。
- [对象存储配置与运维](./storage.md)：MinIO / S3 对象存储配置、Bucket 初始化与私有策略、预签名 URL 交付与常见排障（底层机制见 [存储与评测包交付架构](../system/storage.md)）。
- [提供 LLM 调用能力 (Gateway)](./llm-call-capability.md)：部署 `noj-llm-gateway`，配置主流 LLM Provider、出题人额度分配与鉴权机制。
- [邮件送达与退信处理](./email-delivery.md)：SMTP 邮件服务器配置、送达事件追踪、邮件抑制清单与退信告警处置。

### 3. 系统管控、监控与合规
- [管理后台使用指南 (Admin)](./admin-guide.md)：RBAC 权限分级分配、用户封禁、审计日志溯源、系统公告与社区发帖审核。
- [可观测性与故障排查](./observability.md)：Prometheus 指标埋点、Grafana 仪表盘、系统核心日志与常见高频故障应急处置 Runbook。
- [公测容量基线验收](./capacity-baseline.md)：上线前标准压测条件、并发评测吞吐量验收与性能基准报告模板。
- [法律与合规指南](./legal-compliance.md)：用户服务协议与隐私政策版本化治理、实名备案、内容风控与合规审计要求。
