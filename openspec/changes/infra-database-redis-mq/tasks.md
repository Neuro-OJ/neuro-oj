## 1. 依赖与配置

- [ ] 1.1 更新 `deno.json`：添加 `drizzle-orm`、`@libsql/client`、`ioredis`
      依赖到 imports
- [ ] 1.2 更新 `deno.json` tasks.dev：增加 `--allow-read --allow-write` 权限
- [ ] 1.3 创建 `data/` 和 `data/problems/` 目录（含 .gitkeep）

## 2. 数据库 Schema 定义

- [ ] 2.1 创建 `src/db/schema.ts`：用 Drizzle `sqliteTable` 定义 users 表
- [ ] 2.2 在 `src/db/schema.ts` 中定义 problems 表（含
      judge_image、judge_command、support_package_path）
- [ ] 2.3 在 `src/db/schema.ts` 中定义 submissions 表（含 file_name）
- [ ] 2.4 在 `src/db/schema.ts` 中定义 evaluation_results 表（score 为 INTEGER
      ×100）

## 3. 数据库连接与迁移

- [ ] 3.1 创建 `src/db/connection.ts`：使用 @libsql/client 创建连接，导出
      Drizzle 包装的 db 单例
- [ ] 3.2 创建 `src/db/migrate.ts`：实现 runMigrations()，启动时自动执行 Drizzle
      migration SQL
- [ ] 3.3 创建 `drizzle.config.ts`：配置 schema 路径和 migrations 输出目录

## 4. Redis 消息队列

- [ ] 4.1 创建 `src/mq/connection.ts`：使用 ioredis 创建 Redis 连接，PING
      验证，导出 redis 单例
- [ ] 4.2 创建 `src/mq/producer.ts`：实现 pushJudgeTask(task)，LPUSH 到
      noj:judge:queue

## 5. 共享类型定义

- [ ] 5.1 创建 `src/types/index.ts`：定义 JudgeTask、JudgeResult 接口和状态枚举

## 6. 启动集成

- [ ] 6.1 修改 `src/routes/health.ts`：增加 database 和 redis 连接状态检查
- [ ] 6.2 修改 `src/main.ts`：启动时依次初始化 DB（迁移 + 验证）和 Redis（PING
      验证）
- [ ] 6.3 修改 `src/db/connection.ts` 和
      `src/mq/connection.ts`：初始化失败时不崩溃，记录错误并在 /health 中暴露

## 7. 测试

- [ ] 7.1 创建 `tests/db/schema.test.ts`：验证 schema
      定义可正常导出，表名和列名符合预期
- [ ] 7.2 运行 `deno lint` 和 `deno fmt` 确保代码质量
