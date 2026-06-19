## Why

Neuro OJ Phase 0 需要打通"提交 → 评测 → 结果"闭环，但当前 noj-core
没有任何数据持久化和消息队列基础设施。所有业务功能（用户、题目、提交、评测）都依赖于数据库和消息队列。此变更建立这两项基础设施，为后续所有功能开发提供地基。

**数据库选型变更说明：** 初期选用 SQLite，但 `@libsql/client` 在 Deno 下不支持
`file:` 协议连接本地文件，因此切换为 PostgreSQL 16（驱动改用纯 JS 实现的
`postgres.js`）。

## What Changes

- **新增**：4
  张核心数据库表（users、problems、submissions、evaluation_results），定义 LMCC
  评测所需的完整数据模型
- **新增**：PostgreSQL 数据库连接层（Drizzle ORM + postgres.js），含自动迁移机制
- **新增**：Redis 消息队列连接 + Producer，支持将评测任务推送到
  `noj:judge:queue`
- **新增**：共享类型定义（JudgeTask、JudgeResult 等）
- **修改**：`/health` 端点增加 DB 和 Redis 连接状态检查
- **修改**：`deno.json` 增加 `drizzle-orm`、`postgres`、`ioredis` 依赖
- **修改**：`docker-compose.yml` 新增 PostgreSQL 16 服务

## Capabilities

### New Capabilities

- `database-schema`: 核心数据模型 — 用户、题目（含 LMCC
  自定义评测镜像/命令/支持包）、提交记录、评测结果。PostgreSQL 持久化 + Drizzle
  ORM 迁移。
- `redis-message-queue`: Redis 消息队列基础设施 —
  连接管理、评测任务生产者（LPUSH 到 `noj:judge:queue`）、评测结果通道约定。

### Modified Capabilities

<!-- 无现有 specs，均为新建 -->

## Impact

- **noj-core/deno.json**: 新增 `drizzle-orm`、`postgres`、`ioredis` 依赖
- **noj-core/src/**: 新增 `db/`、`mq/`、`types/` 三个子模块
- **docker-compose.yml**: 新增 PostgreSQL 16 服务（默认
  `postgres://noj:noj@localhost:5432/noj`）
- **数据存储**: PostgreSQL 数据库 + `data/problems/`（支持包 zip 存放目录）
