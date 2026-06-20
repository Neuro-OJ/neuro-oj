## Context

当前 noj-core 仅有 `GET /health` 端点和 Hono 框架骨架。无数据库、无
Redis、无数据模型。Phase 0
的所有功能（用户系统、题目管理、提交评测）都依赖持久化和消息队列基础设施。

**约束：**

- 必须兼容 Deno 运行时（不能使用 Node.js native addon）
- `@libsql/client` 在 Deno 下不支持 `file:` 协议连接本地 SQLite，因此选用
  PostgreSQL
- 数据库通过 TCP 连接，需 Docker 容器提供 PostgreSQL 服务

## Goals / Non-Goals

**Goals:**

- 建立 4 张核心表的完整数据模型，支持 LMCC 自定义评测模式
- 提供类型安全的数据库访问层（Drizzle ORM + PostgreSQL）
- 启动时自动执行数据库迁移
- 建立 Redis 连接和评测任务 Producer
- 提供共享 TypeScript 类型定义

**Non-Goals:**

- 不实现任何业务 API（用户注册、题目 CRUD 等）
- 不实现 Redis Consumer（属于 noj-judge）
- 不实现认证/授权中间件
- 不支持包上传/管理

## Decisions

### 1. PostgreSQL 而非 SQLite

**选择**：PostgreSQL 16

**理由**：

- `@libsql/client` 在 Deno 下使用的是 Web Standard API 构建，仅支持
  `libsql:`、`wss:`、`ws:`、`https:`、`http:` 协议，不支持 `file:` 协议连接本地
  SQLite
- `postgres`（porsager/postgres）是纯 JS 实现，完美兼容 Deno
- Drizzle ORM 提供统一的查询接口，切换只需换 dialect 和 driver
- PostgreSQL 功能完整，外键约束默认启用，无需 PRAGMA
- 从 Phase 0 直接使用 PostgreSQL，避免后续迁移成本

**替代方案**：

- SQLite + `@db/sqlite`（Deno 原生 SQLite）：Drizzle 不直接支持，需要自定义
  driver
- SQLite + `sql.js`（WASM）：文件 I/O 在 WASM 层受限

### 2. Drizzle ORM 而非 Kysely / 原生 SQL

**选择**：Drizzle ORM

**理由**：

- TypeScript 原生类型安全，schema 定义即类型
- 内置 migration 生成（drizzle-kit）
- 活跃的社区和 Deno 支持
- 方言无关设计，切换数据库只需换 dialect 和 driver

**替代方案**：

- Kysely：优秀但 migration 需额外工具
- 原生 SQL：类型安全不足，随表增多维护成本上升

### 3. postgres.js 作为 PG 驱动

**选择**：`npm:postgres`（porsager/postgres）

**理由**：

- 纯 JS/TS 实现，零 native addon，Deno 完全兼容
- 轻量（~300KB），API 简洁
- Drizzle ORM 官方通过 `drizzle-orm/postgres-js` 支持
- 内置连接池，支持 prepared statements

**替代方案**：`pg`（node-postgres）含有 native addon，Deno 下不兼容。

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

- SQLite 无 DECIMAL 类型，PostgreSQL 虽有 NUMERIC/DECIMAL 但 INTEGER 更高效
- REAL (float) 有 IEEE 754 精度误差，99.5 可能存为 99.49999
- INTEGER 精确无误，比较/排序/聚合可靠

### 6. UUID 使用 Deno 原生 crypto.randomUUID()

**选择**：不引入 uuid 依赖，使用 `crypto.randomUUID()`

**理由**：Deno 内置 Web Crypto API，减少依赖。

## Risks / Trade-offs

- **需要 Docker 运行 PostgreSQL**：开发环境增加了容器依赖，但 docker-compose up
  -d postgres 可一键启动
- **连接字符串泄露风险**：DATABASE_URL 包含密码，禁止硬编码到代码中，仅通过 .env
  或环境变量传入
- **支持包文件与数据库不一致**：zip 文件存储在文件系统（路径相对 CWD），DB
  仅记录路径。后续通过管理 API 和定期校验解决。
- **ioredis 连接断开**：Redis 不可用时 noj-core 无法分发评测任务。ioredis
  内置自动重连，健康检查端点暴露状态。

## Migration Plan

1. 开发者执行 `docker compose up -d postgres` 启动 PostgreSQL
2. 执行 `deno task dev`，Drizzle 在启动时自动执行 migration 建表
3. 回滚：`docker compose down -v postgres` 可删除数据卷重建

## Open Questions

<!-- 无，已在讨论中澄清 -->
