## Context

noj-core 测试隔离目前依赖 `resetDbForTest()` 的 `TRUNCATE + re-seed`，全树约 259 次调用，是串行测试的主要剩余开销。此前已完成 PGlite 模板、bcrypt cost 降低、reset 轻量化，但每次用例仍需要清空全表并重新播种。

本设计引入事务回滚级隔离：每个测试用例在一个数据库事务中执行，用例结束统一 `ROLLBACK`，让用例内 `resetDbForTest()` 变成 no-op。

## Goals / Non-Goals

**Goals:**

- 让 PGlite 和 PostgreSQL 两种测试模式都支持事务回滚隔离。
- 对业务代码透明，不修改 15+ 处 `db.transaction()` 调用。
- 纯单元测试不产生额外数据库开销（惰性开启事务）。
- 保留模块级 `resetDbForTest()` 用于建立每个测试文件的初始状态。

**Non-Goals:**

- 不改变生产代码行为。
- 不引入并行分片。
- 不要求修改所有测试文件；提供全局 preload 包装 + 文件级 opt-out。

## Decisions

### 1. 使用 Deno `--preload` 全局包装 `Deno.test`

新增 `tests/preload.ts`，通过 `deno test --preload=tests/preload.ts` 在测试模块加载前包装 `Deno.test`，为每个用例自动加上事务生命周期。

**理由**：避免逐个修改测试文件；preload 是 Deno 原生机制。

### 2. 惰性事务开启

`beginTestTransaction()` 只设置 `pending` 标记，不连接数据库。首次调用 `getDb()` 时才真正开启事务。

**理由**：纯单元测试从不调用 `getDb()`，因此零 DB 开销。

### 3. Savepoint 代理层兼容嵌套事务

服务层大量使用 `db.transaction()`。直接在外层事务中嵌套 `BEGIN` 在 PGlite 上会挂起/破坏回滚。因此 `getDb()` 在测试事务内返回一个 `Proxy`，将 `transaction()` 转成 `SAVEPOINT / RELEASE / ROLLBACK TO`。

**已验证**：PGlite 手工 savepoint 模拟嵌套事务行为正确。

### 4. PGlite 与 PG 双实现

- **PGlite**：在现有实例上 `BEGIN` / `ROLLBACK`，不关闭实例。
- **PG**：每个测试事务创建一条 `max: 1` 的专用连接，`ROLLBACK` 后关闭；不干扰共享连接池。

### 5. `resetDbForTest()` 事务内 no-op

在 active 测试事务内调用 `resetDbForTest()` 直接返回；模块级（事务外）调用保持现有行为。

## Architecture

```
tests/preload.ts
        │  包装 Deno.test
        ▼
TestTransactionManager（connection.ts）
        │  惰性开启 / 统一回滚
        ▼
TestTransactionDb（Proxy + SAVEPOINT）
        ▼
业务 service（零改动）
```

## Detailed Design

### TestTransactionManager

状态机：

```ts
type TestTransactionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "active"; db: TestTransactionDb };
```

函数：

- `beginTestTransaction()`：`idle -> pending`
- `rollbackTestTransaction()`：`active -> ROLLBACK + 清理连接 -> idle`；`pending -> idle`
- `getTestTransactionDb()`：`pending -> active`（真正开启事务）；`active -> 返回事务 db`
- `isTestTransactionDisabled()`：文件级 opt-out 标记

### getDb 修改

```ts
if (testState.status === "pending") {
  testState = await startRealTransaction();
}
if (testState.status === "active") {
  return testState.db;
}
// 正常返回全局 db
```

### TestTransactionDb Proxy

```ts
function createTestTransactionDb(realDb: Db): Db {
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "transaction") return savepointTransaction;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}
```

savepoint 事务：

```ts
let savepointSeq = 0;

async function savepointTransaction(callback, _config?) {
  const db = getRawTransactionDb();
  const name = `noj_sp_${savepointSeq++}`;
  await db.execute(sql`SAVEPOINT ${sql.raw(name)}`);
  try {
    const result = await callback(testProxy);
    await db.execute(sql`RELEASE SAVEPOINT ${sql.raw(name)}`);
    return result;
  } catch (err) {
    await db.execute(sql`ROLLBACK TO SAVEPOINT ${sql.raw(name)}`);
    await db.execute(sql`RELEASE SAVEPOINT ${sql.raw(name)}`);
    throw err;
  }
}
```

### resetDbForTest

- 模块级（事务外）：现有行为。
- 用例内（active/pending）：直接返回。

### 文件级 Opt-out

```ts
import { disableTestTransactionForFile } from "../src/db/connection.ts";
disableTestTransactionForFile();
```

调用后该文件所有用例跳过事务包装，继续使用原 reset 行为。

## Risks / Trade-offs

- [现有测试存在跨用例数据依赖] → 全量回归暴露后，用 `disableTestTransactionForFile()` 逐文件退出。
- [Proxy 类型兼容性] → 通过类型断言收敛到 Drizzle db 类型；在实现阶段用现有服务层测试验证。
- [PG 每用例一条短连接] → 连接开销远小于 TRUNCATE + seed，且惰性开启只影响 DB 用例。
- [PGlite savepoint 行为差异] → 已用探针验证手工 savepoint 可用；实现时补充针对 `db.transaction` 的回归测试。

## Migration Plan

1. 在 `connection.ts` 中实现 TestTransactionManager、TestTransactionDb、savepoint 代理。
2. 新增 `tests/preload.ts` 包装 `Deno.test`。
3. 在 `deno.json` 的 `test` / `test:watch` / `test:pg` 以及 `scripts/test-parallel.ts` 子进程中加入 `--preload=tests/preload.ts`。
4. 调整 `resetDbForTest()` 事务内 no-op。
5. 运行全量 `deno task test` 与 PG 模式回归，处理跨用例依赖文件。
6. 对比优化前后耗时。

## Open Questions

- 是否需要为 smoke test 单独关闭事务包装（当前设计认为不需要，但以全量回归结果为准）。
- PG 模式下 `test:parallel` 是否也启用 preload（建议启用，但需确认与现有 TEST_SCHEMA 分片不冲突）。
