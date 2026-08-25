# 系统架构

Neuro OJ 由多个模块组成，通过 RESTful API、Redis 消息队列和内部 HTTP 服务协作：

- **noj-core**：Deno + Hono，提供 RESTful API、JWT 鉴权 + RBAC、题目/提交/竞赛/社区 CRUD、Redis MQ Producer/Consumer、LLM 管理 API 客户端。
- **noj-ui**：Nuxt 4 + Vue 3，Web 前端，Nitro 反向代理注入 JWT Cookie。
- **noj-judge**：Rust + Tokio，Docker 沙箱评测，双容器架构（Evaluator + Solution）。
- **noj-llm-gateway**：Deno + Hono，LLM 调用网关，负责上游 Provider API Key 加密托管、短期 eval_token、限流/额度与用量审计；evaluator 只通过它访问外部 LLM API。
- **基础设施**：PostgreSQL 16（持久化）、Redis 7（MQ + 缓存）、MinIO/S3（对象存储）、Nginx（生产入口 / TLS 终止后的反代）。

生产环境使用 Docker Compose 编排；评测支持包通过 `noj-storage://` 持久化，并通过 `noj-download://` 交付给 Judge Worker。

详细模块职责见仓库根目录 `AGENTS.md`。
