## Context

当前 noj-core 仅有 `GET /health` 端点和 Hono 框架骨架。无数据库、无
Redis、无数据模型。Phase 0
的所有功能（用户系统、题目管理、提交评测）都依赖持久化和消息队列基础设施。

**约束：**

- 必须兼容 Deno 运行时（不能使用 Node.js native addon）
- Phase 0 MVP 阶段，优先简单性；后续可迁移到 PostgreSQL
- 数据库文件存储在 `noj-core/data/` 目录

## Goals / Non-Goals

**Goals:**

- 建立 4 张核心表的完整数据模型，支持 LMCC 自定义评测模式
- 提供类型安全的数据库访问层（Drizzle ORM）
- 启动时自动执行数据库迁移
- 建立 Redis 连接和评测任务 Producer
- 提供共享 TypeScript 类型定义

**Non-Goals:**

- 不实现任何业务 API（用户注册、题目 CRUD 等）
- 不实现 Redis Consumer（属于 noj-judge）
- 不实现认证/授权中间件
- 不支持包上传/管理
- 不处理 PostgreSQL 迁移

## Decisions

### 1. SQLite 而非 PostgreSQL

**选择**：SQLite 文件数据库

**理由**：

- Phase 0 零配置部署，无需独立数据库容器
- 单文件易于备份和种子数据
- Drizzle ORM 提供统一的查询接口，后续改一行配置即可切换到 PostgreSQL
- Deno 通过 @libsql/client 有良好的 SQLite 支持

**替代方案**：PostgreSQL 需要独立容器，增加 MVP 部署复杂度。Phase 1+ 再引入。

### 2. Drizzle ORM 而非 Kysely / 原生 SQL

**选择**：Drizzle ORM

**理由**：

- TypeScript 原生类型安全，schema 定义即类型
- 内置 migration 生成（drizzle-kit）
- 活跃的社区和 Deno 支持
- 方言无关设计，SQLite ↔ PostgreSQL 切换只需换 dialect 和 driver

**替代方案**：

- Kysely：优秀但 migration 需额外工具
- 原生 SQL：对于 4 张表可行，但随着表增多类型安全价值凸显

### 3. @libsql/client 作为 SQLite 驱动

**选择**：@libsql/client embedded 模式

**理由**：

- Drizzle 官方的 SQLite 驱动推荐
- 支持 embedded 模式（直接打开文件，无需 libsql server）
- 纯 JS/TS 实现，兼容 Deno npm 层
- 比 better-sqlite3（Node.js native addon）更适合 Deno

**替代方案**：Deno 原生 `jsr:@db/sqlite` 但 Drizzle 不直接支持，需要自定义
driver。

### 4. ioredis 而非 @redis/client

**选择**：ioredis

**理由**：

- 最成熟的 Node.js Redis 客户端，经过大量生产验证
- 内置连接池、自动重连、Pub/Sub、Promise API
- Deno npm 兼容层已验证可用

**替代方案**：@redis/client 更轻量但生态不如 ioredis 成熟。

### 5. 分数存储使用 INTEGER ×100

**选择**：INTEGER 存储缩放值（score × 100）

**理由**：

- SQLite 无 DECIMAL 类型
- REAL (float) 有 IEEE 754 精度误差，99.5 可能存为 99.49999
- TEXT 无法在 SQL 中做聚合运算
- INTEGER 精确无误，比较/排序可靠，API 层转换简单

### 6. UUID 使用 Deno 原生 crypto.randomUUID()

**选择**：不引入 uuid 依赖，使用 `crypto.randomUUID()`

**理由**：Deno 内置 Web Crypto API，减少依赖。

## Risks / Trade-offs

- **SQLite 并发写入瓶颈**：单文件数据库在高并发场景下写入性能有限。Phase 3
  迁移到 PostgreSQL 解决。Phase 0-1 的单机部署完全足够。
- **@libsql/client 版本稳定性**：相对于 better-sqlite3 较新，API
  可能变动。锁定小版本号规避。
- **支持包文件与数据库不一致**：zip 文件存储在文件系统，DB
  仅记录路径。文件可能被手动删除导致不一致。后续通过管理 API 和定期校验解决。
- **ioredis 连接断开**：Redis 不可用时 noj-core 无法分发评测任务。ioredis
  内置自动重连，健康检查端点暴露状态。

## Migration Plan

1. 合并此 PR 后，开发者执行 `deno task dev`，Drizzle 自动在 `data/` 目录创建
   SQLite 数据库文件并执行 migration
2. 无需手动迁移步骤
3. 回滚：删除 `data/noj.db` 文件即可重置数据库

## Open Questions

<!-- 无，已在讨论中澄清 -->
