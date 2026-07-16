# 运营者文档

运营者负责部署、初始化和维护 NOJ 实例。

## 你需要维护的组件

- PostgreSQL：持久化用户、题目、提交、结果和配置。
- Redis：评测任务队列、结果队列和 core/judge RPC。
- noj-core：Deno + Hono 后端。
- noj-ui：Nuxt 前端。
- noj-judge：Rust + Docker Judge Worker。
- Docker 镜像：Evaluator 和 Solution 双容器运行时。

## 继续阅读

- [本地启动](local-start.md)
- [初始化与 seed](seed.md)
- [存储与支持包交付](storage.md)
- [Judge Worker 运维](judge-workers.md)
