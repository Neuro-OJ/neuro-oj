# NOJ 文档

欢迎来到 Neuro OJ（NOJ）文档。NOJ 是一个面向 LMCC（CCF 大语言模型能力认证）的在线评测系统，独立社区项目，与 CCF 及 LMCC 无官方关系。

## NOJ 是什么

NOJ 提供完整的「注册 → 做题 → 提交 → 评测结果」闭环，并在此基础上扩展了榜单、每日签到、站内私信、竞赛、社区与 RBAC 权限等能力。

### 核心功能

- **函数调用型评测**：题目要求实现声明的函数，出题人编写 evaluator 调用用户函数并评分，而非传统的 stdin/stdout 判题。
- **双容器隔离评测**：用户代码与出题人评测代码分别在独立 Docker 沙箱容器中运行（网络关闭、无特权、资源受限）。
- **在线编辑器**：Monaco 编辑器，支持语法高亮、提交历史与实时评测状态。
- **社区与竞赛**：帖子/评论/关注动态流，icpc/ioi/oi 三赛制竞赛与实时排名。
- **RBAC 权限**：角色-权限点模型，管理后台可精细控制。

### 系统架构

NOJ 由三个模块通过 RESTful API 和 Redis 消息队列协作：

```
+----------+   RESTful API   +----------+   Redis MQ    +--------------+
|  noj-ui  | <-------------> | noj-core | --Producer--> |  noj-judge   |
|  Nuxt 4  |                 | Deno+Hono| <--Consumer--|  Rust+Docker  |
+----------+                 +----------+               +--------------+
                                   |
                              +----+----+
                              |  Redis   |
                              +---------+
```

- **noj-ui**（Nuxt 4 + Vue 3）— Web 前端：题目列表、代码编辑器、提交结果页、管理后台等。
- **noj-core**（Deno + Hono）— RESTful API：用户/题目/提交/榜单等业务，Redis MQ 生产者与消费者。
- **noj-judge**（Rust + Tokio）— 评测 Worker：从 MQ 拉取任务，在 Docker 沙箱中执行评测并回传结果。
- **PostgreSQL 16** — 持久化存储；**Redis 7** — 消息队列与缓存。

### 评测消息流

1. 用户在 noj-ui 提交代码。
2. noj-core 接收请求，将评测任务发布到 Redis 队列（`noj:judge:queue`）。
3. noj-judge 从队列拉取任务。
4. Worker 在 Docker 容器中执行评测（资源隔离、网络关闭）。
5. 结果回写 Redis（`noj:judge:results`）。
6. noj-core 消费结果并持久化到数据库。

## 按角色阅读

- **做题人**：[快速开始](users/getting-started.md) → [提交代码](users/submit.md) → [理解结果](users/results.md)
- **运营者**：[本地启动](operators/local-start.md) → [后台管理指南](operators/admin-guide.md)
- **出题人**：[评测模型](problemsetters/judge-model.md) → [Web 题目编辑器](problemsetters/web-editor.md) → [A+B 示例题](problemsetters/ab-example.md)
- **参考**：[术语表](reference/glossary.md) · [结果状态](reference/result-status.md) · [FAQ](reference/faq.md)
