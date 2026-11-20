/**
 * 数据库迁移 advisory lock 失败语义单元测试。
 *
 * 背景（2026-10-20 架构整治 P1b）：`withMigrationLock` 此前在锁连接创建失败、
 * 等待超时等路径上 `log` 后继续执行 `fn()`，导致保护条件失效后仍执行 DDL。
 * 本文件用**注入的假锁连接 / 假时钟**覆盖新的失败语义：
 * - 只有真正拿到锁才执行 `fn()`；
 * - 连接创建失败、`pg_try_advisory_lock` 抛错、等待超时、缺 DATABASE_URL 一律
 *   reject `MigrationLockError` 且 `fn()` 未被调用；
 * - 出错时专用锁连接仍会被关闭；释放锁失败不掩盖主流程错误。
 *
 * 全部用例不读取 DATABASE_URL、不建立真实 PostgreSQL 连接、不创建真实定时器。
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import {
  type LockConnection,
  type MigrationLockDeps,
  MigrationLockError,
  schemaLockKey,
  withMigrationLock,
} from "../../src/shared/db/migrate.ts";

/** 假锁连接行为选项。 */
interface FakeLockConnectionOptions {
  /** pg_try_advisory_lock 的返回值；false 表示锁被其它会话占用。 */
  locked?: boolean;
  /** pg_try_advisory_lock 抛出的错误。 */
  lockError?: Error;
  /** pg_advisory_unlock 抛出的错误。 */
  unlockError?: Error;
}

/** 假锁连接：记录发出的 SQL 与是否已关闭，不连接任何数据库。 */
interface FakeLockConnection {
  /** 作为依赖注入的锁连接。 */
  conn: LockConnection;
  /** 已发出的 SQL（按调用顺序）。 */
  queries: Array<{ query: string; params?: unknown[] }>;
  /** 连接是否已被 end() 关闭。 */
  isClosed: () => boolean;
}

/** 创建假锁连接。 */
function createFakeLockConnection(
  options: FakeLockConnectionOptions = {},
): FakeLockConnection {
  const queries: Array<{ query: string; params?: unknown[] }> = [];
  let closed = false;
  const conn: LockConnection = {
    unsafe: (query, params) => {
      queries.push({ query, params });
      if (query.includes("pg_try_advisory_lock")) {
        return options.lockError
          ? Promise.reject(options.lockError)
          : Promise.resolve([{ locked: options.locked ?? true }]);
      }
      if (query.includes("pg_advisory_unlock")) {
        return options.unlockError
          ? Promise.reject(options.unlockError)
          : Promise.resolve([{ unlocked: true }]);
      }
      return Promise.resolve([]);
    },
    end: () => {
      closed = true;
      return Promise.resolve();
    },
  };
  return { conn, queries, isClosed: () => closed };
}

/** 生产默认依赖的替身：不读 env、不建连接、不真 sleep。 */
function fakeDeps(
  conn: LockConnection,
  overrides: Partial<MigrationLockDeps> = {},
): Partial<MigrationLockDeps> {
  return {
    getDatabaseUrl: () => "postgres://fake:fake@127.0.0.1:1/fake",
    createConnection: () => conn,
    sleep: () => Promise.resolve(),
    now: () => 0,
    ...overrides,
  };
}

/** 假时钟：now 只在 sleep 时推进，不创建真实定时器。 */
function createFakeClock(): Pick<MigrationLockDeps, "now" | "sleep"> {
  let current = 0;
  return {
    now: () => current,
    sleep: (ms) => {
      current += ms;
      return Promise.resolve();
    },
  };
}

Deno.test("migrate lock: 拿到锁后执行 fn 且锁连接最终关闭", async () => {
  const fake = createFakeLockConnection({ locked: true });
  let called = 0;

  const result = await withMigrationLock(
    "test_lock_ok",
    () => {
      called++;
      return Promise.resolve("migrated");
    },
    fakeDeps(fake.conn),
  );

  // 拿到锁才执行迁移，且返回值透传
  assertEquals(result, "migrated");
  assertEquals(called, 1);
  // 锁连接必须关闭（会话级锁随连接释放）
  assertEquals(fake.isClosed(), true);
  // 第二个键由 schema 派生：不同 schema 互不阻塞、同 schema 串行
  const tryLock = fake.queries.find((q) =>
    q.query.includes("pg_try_advisory_lock")
  );
  assertEquals(tryLock?.params?.[1], schemaLockKey("test_lock_ok"));
  // finally 中显式解锁（不能只依赖连接关闭）
  assertEquals(
    fake.queries.some((q) => q.query.includes("pg_advisory_unlock")),
    true,
  );
});

Deno.test("migrate lock: 等待超时拒绝且 fn 未执行、错误含 schema", async () => {
  const clock = createFakeClock();
  const fake = createFakeLockConnection({ locked: false });
  let called = false;

  const err = await assertRejects(
    () =>
      withMigrationLock(
        "test_lock_timeout",
        () => {
          called = true;
          return Promise.resolve();
        },
        fakeDeps(fake.conn, {
          sleep: clock.sleep,
          now: clock.now,
          waitTimeoutMs: 10_000,
          retryIntervalMs: 2_000,
        }),
      ),
    MigrationLockError,
  );

  assertEquals(called, false);
  assertStringIncludes(err.message, "test_lock_timeout");
  assertStringIncludes(err.message, "10 秒");
  // 未持有锁 → 不应发解锁语句；但专用连接必须关闭
  assertEquals(
    fake.queries.some((q) => q.query.includes("pg_advisory_unlock")),
    false,
  );
  assertEquals(fake.isClosed(), true);
  // 应重试多次后才超时（2s 间隔 / 10s 上限）
  const attempts =
    fake.queries.filter((q) => q.query.includes("pg_try_advisory_lock")).length;
  assertEquals(attempts > 1, true);
});

Deno.test("migrate lock: 锁连接创建失败拒绝且 fn 未执行", async () => {
  let called = false;

  const err = await assertRejects(
    () =>
      withMigrationLock(
        "test_lock_connect",
        () => {
          called = true;
          return Promise.resolve();
        },
        {
          getDatabaseUrl: () => "postgres://fake:fake@127.0.0.1:1/fake",
          createConnection: () => {
            throw new Error("connect refused");
          },
          sleep: () => Promise.resolve(),
          now: () => 0,
        },
      ),
    MigrationLockError,
  );

  assertEquals(called, false);
  assertStringIncludes(err.message, "test_lock_connect");
  assertStringIncludes(err.message, "connect refused");
});

Deno.test("migrate lock: pg_try_advisory_lock 抛错拒绝且 fn 未执行", async () => {
  const fake = createFakeLockConnection({
    lockError: new Error("server closed the connection unexpectedly"),
  });
  let called = false;

  const err = await assertRejects(
    () =>
      withMigrationLock(
        "test_lock_query",
        () => {
          called = true;
          return Promise.resolve();
        },
        fakeDeps(fake.conn),
      ),
    MigrationLockError,
  );

  assertEquals(called, false);
  assertStringIncludes(err.message, "test_lock_query");
  assertStringIncludes(
    err.message,
    "server closed the connection unexpectedly",
  );
  assertEquals(fake.isClosed(), true);
});

Deno.test("migrate lock: 释放锁失败不掩盖主错误", async () => {
  const fake = createFakeLockConnection({
    locked: true,
    unlockError: new Error("unlock failed"),
  });
  let called = 0;

  const err = await assertRejects(
    () =>
      withMigrationLock(
        "test_lock_release",
        () => {
          called++;
          throw new Error("迁移主流程失败");
        },
        fakeDeps(fake.conn),
      ),
    Error,
  );

  assertEquals(called, 1);
  // 主流程错误必须原样抛出，解锁失败只记日志
  assertEquals(err.message, "迁移主流程失败");
  assertEquals(fake.isClosed(), true);
});

Deno.test("migrate lock: 缺少 DATABASE_URL 拒绝且 fn 未执行", async () => {
  let called = false;
  let connectionCreated = false;

  const err = await assertRejects(
    () =>
      withMigrationLock(
        "test_lock_no_url",
        () => {
          called = true;
          return Promise.resolve();
        },
        {
          getDatabaseUrl: () => undefined,
          createConnection: () => {
            connectionCreated = true;
            return createFakeLockConnection().conn;
          },
          sleep: () => Promise.resolve(),
          now: () => 0,
        },
      ),
    MigrationLockError,
  );

  assertEquals(called, false);
  assertEquals(connectionCreated, false);
  assertStringIncludes(err.message, "DATABASE_URL");
  assertStringIncludes(err.message, "test_lock_no_url");
  assertStringIncludes(err.message, "无锁");
});
