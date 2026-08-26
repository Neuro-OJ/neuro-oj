## 1. TestTransactionManager

- [x] 1.1 在 `src/db/connection.ts` 中新增测试事务状态机（idle / pending / active）
- [x] 1.2 实现 `beginTestTransaction()`：设置 pending 标记，不连接数据库
- [x] 1.3 实现 `rollbackTestTransaction()`：active 时执行 ROLLBACK 并清理事务状态，随后回到 idle
- [x] 1.4 实现 `isInsideTestTransaction()` 与 `isTestTransactionDisabled()`
- [x] 1.5 实现 `disableTestTransactionForFile()` 文件级 opt-out

## 2. 惰性事务与 getDb 接入

- [x] 2.1 实现 `startRealTransaction()`：PGlite 执行 BEGIN；PG 在测试模式单连接上 BEGIN
- [x] 2.2 修改 `getDb()`：pending 时通过 reset 触发开启事务，active 时返回事务 db
- [x] 2.3 在 `closeDbForShutdown()` 中先回滚 active 事务再关闭连接

## 3. TestTransactionDb Savepoint 代理

- [x] 3.1 实现 `createTestTransactionDb(realDb)` Proxy，仅拦截 `transaction`
- [x] 3.2 实现 savepoint 事务函数：`SAVEPOINT / RELEASE / ROLLBACK TO`，支持嵌套
- [x] 3.3 每次测试事务开始时重置 savepoint 序号
- [x] 3.4 用现有服务层 `db.transaction()` 用例验证代理兼容性

## 4. resetDbForTest 事务内 no-op

- [x] 4.1 修改 `resetDbForTest()`：active 测试事务内直接返回，pending 时先 reset 再开启事务
- [x] 4.2 确认模块级 `resetDbForTest()` 仍保持现有行为

## 5. preload 包装与任务接入

- [x] 5.1 新增 `tests/preload.ts`，包装 `Deno.test` 并调用 begin/rollback
- [x] 5.2 兼容 `Deno.test(name, fn)` 与 `Deno.test(options)` 两种调用形式
- [x] 5.3 在 `deno.json` 的 `test` / `test:watch` / `test:pg` 中加入 `--preload=tests/preload.ts`
- [x] 5.4 在 `scripts/test-parallel.ts` 子进程参数中加入 `--preload=tests/preload.ts`

## 6. 跨用例依赖处理

- [x] 6.1 运行全量测试，识别需要关闭事务包装的文件
- [x] 6.2 对存在跨用例依赖的文件调用 `disableTestTransactionForFile()`
- [x] 6.3 确认 smoke test 等特殊文件行为正确

## 7. 验证与回归

- [x] 7.1 运行 `deno fmt --check` 和 `deno lint`
- [x] 7.2 运行 `deno task test` 全量回归
- [x] 7.3 运行 PG 模式小规模回归（`test:pg` 或 `test:parallel` 子集）
- [x] 7.4 记录优化前后耗时，确认事务回滚隔离带来显著提升
