/**
 * 测试事务 savepoint 模拟的并发正确性回归（2026-10-11 复审问题 4）。
 *
 * 背景：测试事务只用一条连接（测试模式 `max: 1`），而 savepoint 是连接级状态。
 * 两个 `db.transaction()` 回调若交错执行，先完成的 `RELEASE` 会连带释放后创建的
 * savepoint，后一个 RELEASE 报 `3B001`；若实现把这些记账错误吞掉，就会出现
 * **两个事务都返回成功、下一条查询却报 `25P02`（事务已中止）** 的假成功。
 *
 * 本用例断言：
 * 1. 共享连接上的兄弟事务被串行化（不交错）；
 * 2. 两个事务都真实生效（后一条查询可见两者结果，而不是报 25P02）；
 * 3. 内层失败只回滚内层 savepoint，外层事务仍可继续使用。
 *
 * 无 DATABASE_URL 时按项目约定跳过（PGlite 的单连接语义不同，不做等价断言）。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import {
  getDb,
  isInsideTestTransaction,
} from "../../src/shared/db/connection.ts";
import { unwrapRows } from "../../src/shared/base/sql-rows.ts";

const hasPg = !!Deno.env.get("DATABASE_URL");

Deno.test({
  name: "test-tx: 共享连接上的兄弟事务串行执行，不产生假成功（25P02）",
  ignore: !hasPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    assert(isInsideTestTransaction(), "用例应运行在测试事务内");
    const db = getDb();
    const order: string[] = [];

    const a = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_sleep(0.05)`);
      order.push("A");
      return "A returned";
    });
    const b = db.transaction(async (tx) => {
      order.push("B");
      return "B returned";
    });

    const [ra, rb] = await Promise.all([a, b]);
    assertEquals(ra, "A returned");
    assertEquals(rb, "B returned");
    // 串行化：B 不会在 A 的 savepoint 生命周期内开始
    assertEquals(order, ["A", "B"]);

    // 关键断言：事务仍然可用（旧实现此处抛 25P02）
    const rows = unwrapRows<{ ok: number }>(
      await db.execute(sql`SELECT 1 AS ok`) as never,
    );
    assertEquals(rows[0].ok, 1, "兄弟事务后连接事务必须仍然可用");
  },
});

Deno.test({
  name: "test-tx: 内层事务失败只回滚内层，外层事务继续可用",
  ignore: !hasPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const before = unwrapRows<{ ok: number }>(
      await db.execute(sql`SELECT 1 AS ok`) as never,
    );
    assertEquals(before[0].ok, 1);

    let threw = false;
    try {
      await db.transaction(async () => {
        throw new Error("内层失败");
      });
    } catch {
      threw = true;
    }
    assertEquals(threw, true, "内层错误必须向外传播");

    const after = unwrapRows<{ ok: number }>(
      await db.execute(sql`SELECT 2 AS ok`) as never,
    );
    assertEquals(after[0].ok, 2, "内层失败不得中止外层事务");
  },
});

Deno.test({
  name: "test-tx: 内层嵌套事务不与外层互等（reentrancy 不死锁）",
  ignore: !hasPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const events: string[] = [];
    const outer = await db.transaction(async (tx) => {
      events.push("outer-begin");
      const inner = await db.transaction(async () => {
        events.push("inner");
        return "inner-value";
      });
      await tx.execute(sql`SELECT 1`);
      events.push("outer-end");
      return inner;
    });
    assertEquals(outer, "inner-value");
    // 内层必须在外层结束前完成（同一逻辑事务的嵌套语义）
    assertEquals(events, ["outer-begin", "inner", "outer-end"]);
  },
});
