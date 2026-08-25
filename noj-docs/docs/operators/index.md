# 运营者文档

运营者文档覆盖从公测部署到日常维护的完整路径。

## 文档内容

- **生产部署**：基于 Docker Compose + ghcr.io 镜像的公测部署、初始化、升级与回滚。
- **生产密钥轮换**：生产 secret 注入、S3/邮件/数据库/Redis 凭据轮换与回滚 Runbook。
- **如何提供 LLM 调用能力**：部署 gateway、配置 Provider、网络要求与出题人对接。
- **CLI 初始化**：数据库迁移、系统初始化与管理引导等 CLI 命令（生产容器内执行）。
- **存储与评测包交付**：`noj-storage://` / `noj-download://` 两层 URL 与存储后端。
- **Judge Worker 运维**：评测镜像、评测流程、队列监控与水平扩展。
- **后台管理指南**：RBAC 权限、用户封禁、审计日志、系统设置、LLM Provider/用量与题目管理。

## 你需要维护的组件

- PostgreSQL：持久化用户、题目、提交、结果和配置。
- Redis：评测任务队列、结果队列和 core/judge RPC。
- noj-core：Deno + Hono 后端。
- noj-ui：Nuxt 前端。
- noj-judge：Rust + Docker Judge Worker。
- noj-llm-gateway：LLM 调用网关（Provider Key 托管、eval_token、限流/额度与用量审计）。
- MinIO：自建对象存储（支持包与头像等）。
- Docker 镜像：Evaluator 和 Solution 双容器运行时。
