# 运营者文档

运营者文档覆盖从公测部署到日常维护的完整路径。

## 建议阅读顺序

1. [生产部署](./production-deploy.md)：基于 Docker Compose + ghcr.io 镜像的公测部署、初始化、升级与回滚。
2. [生产密钥](./production-secrets.md)：secret 注入，S3/邮件/数据库/Redis 凭据轮换与回滚 Runbook。
3. [公测容量基线](./capacity-baseline.md)：上线前的可重复容量验收方法。
4. [可观测性与故障处理](./observability.md)：Prometheus/告警配置与常见故障处置。

## 文档内容

| 文档 | 内容 |
|---|---|
| [生产部署](./production-deploy.md) | 安装、配置、升级/回滚、备份与恢复演练 |
| [生产密钥](./production-secrets.md) | 各类凭据轮换 Runbook 与回滚 |
| [公测容量基线](./capacity-baseline.md) | 固定测试条件、验收场景、报告模板 |
| [可观测性与故障处理](./observability.md) | 观测入口、Prometheus/告警、故障 Runbook |
| [如何提供 LLM 调用能力](./llm-call-capability.md) | 部署 gateway、配置 Provider、网络要求与出题人对接 |
| [CLI 初始化](./cli.md) | 数据库迁移、系统初始化、管理员引导（生产容器内执行） |
| [Judge Worker 运维](./judge-workers.md) | 评测镜像、评测流程、队列监控与水平扩展 |
| [邮件退信与送达质量](./email-delivery.md) | 送达事件、抑制清单与告警处置 |
| [后台管理指南](./admin-guide.md) | RBAC、用户封禁、审计日志、系统设置、公告、题单、社区审核、LLM 管理与题目管理 |
| [法律与合规](./legal-compliance.md) | 隐私政策/服务条款版本化、注册同意、备案、内容审核、数据清单与 TSA |

存储与评测包交付见[系统架构与运维主题](../system/storage.md)。

## 你需要维护的组件

| 组件 | 职责 |
|---|---|
| PostgreSQL | 持久化用户、题目、提交、结果和配置 |
| Redis | 评测任务队列、结果队列和 core/judge RPC |
| noj-core | Deno + Hono 后端 |
| noj-ui | Nuxt 前端 |
| noj-judge | Rust + Docker Judge Worker |
| noj-llm-gateway | LLM 调用网关（Provider Key 托管、eval_token、限流/额度与用量审计） |
| MinIO | 自建对象存储（支持包与头像等） |
| Docker 镜像 | Evaluator 和 Solution 双容器运行时 |
