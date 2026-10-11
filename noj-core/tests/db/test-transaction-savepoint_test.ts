/**
 * 测试事务 savepoint 模拟的并发正确性回归（2026-10-11 复审问题 3 与 9）。
 *
 * 测试事务只用一条连接（测试模式 `max: 1`），而 savepoint 是连接级状态：
 * - 两个 `db.transaction()` 回调交错执行 → 先完成的 `RELEASE` 连带释放后创建的
 *   savepoint → 后一个 RELEASE 报 `3B001`，事务中止后无法自愈（假成功 + 下一条查询
 *   报 `25P02`）；
 * - 但"内层"调用不能简单进全局队列，否则与外层互等（死锁）。
 *
 * 因此实现按**异步上下文**区分：同一执行链根 → 内层（进该根嵌套队列）；链外发起
 * → 独立兄弟（进全局队列）。本文件覆盖四种窗口：
 * 1. 同时启动的两个独立兄弟；
 * 2. 外层回调**已开始后**才启动的独立兄弟（旧实现会绕过串行队列）；
 * 3. 子 A 暂停后，外层 ALS 上下文启动同级子 B（不能依赖运行栈顶判定父子）；
 * 4. 外层回调内 `Promise.all()` 启动的两个内层事务（必须按序，不能交错）。
 *
 * 无 DATABASE_URL 时按项目约定跳过（PGlite 单连接语义不同，不做等价断言）。
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
  name: "test-tx: 同时启动的兄弟事务串行执行，事务仍可用（不产生 25P02）",
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
      await tx.execute(sql`SELECT 1`);
      order.push("B");
      return "B returned";
    });

    const [ra, rb] = await Promise.all([a, b]);
    assertEquals(ra, "A returned");
    assertEquals(rb, "B returned");
    assertEquals(order, ["A", "B"], "兄弟事务必须串行（B 不得在 A 内开始）");

    const rows = unwrapRows<{ ok: number }>(
      await db.execute(sql`SELECT 1 AS ok`) as never,
    );
    assertEquals(rows[0].ok, 1, "兄弟事务后连接事务必须仍然可用");
  },
});

Deno.test({
  name: "test-tx: 外层已开始后才启动的独立兄弟仍被串行（延迟启动窗口）",
  ignore: !hasPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const order: string[] = [];
    let releaseA: () => void = () => {};
    const aMayFinish = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let markEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });

    const a = db.transaction(async (tx) => {
      order.push("A-begin");
      markEntered();
      await aMayFinish; // 屏障：确保 B 在 A 回调**已开始后**才被启动
      await tx.execute(sql`SELECT 1`);
      order.push("A-end");
      return "A";
    });

    await entered;
    // 从执行链**外部**启动独立兄弟：旧实现（只看 depth>0）会直接放行并交错。
    const b = db.transaction(async (tx) => {
      order.push("B-begin");
      await tx.execute(sql`SELECT 1`);
      order.push("B-end");
      return "B";
    });
    releaseA();

    const [ra, rb] = await Promise.all([a, b]);
    assertEquals(ra, "A");
    assertEquals(rb, "B");
    assertEquals(order, ["A-begin", "A-end", "B-begin", "B-end"]);

    const rows = unwrapRows<{ ok: number }>(
      await db.execute(sql`SELECT 7 AS ok`) as never,
    );
    assertEquals(rows[0].ok, 7, "延迟启动的兄弟事务后事务必须仍然可用");
  },
});

Deno.test({
  name: "test-tx: 子 A 暂停时外层启动子 B，B 仍归属外层子队列",
  ignore: !hasPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const order: string[] = [];
    let releaseA: () => void = () => {};
    const aMayFinish = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let markEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let childBFinished = false;

    const outer = await db.transaction(async (tx) => {
      const childA = db.transaction(async (inner) => {
        order.push("A-begin");
        markEntered();
        await aMayFinish;
        await inner.execute(sql`SELECT 1`);
        order.push("A-end");
      });

      // A 已进入并暂停；此 await 保留外层的 ALS 父节点上下文。
      await entered;
      const childB = db.transaction(async (inner) => {
        order.push("B-begin");
        await inner.execute(sql`SELECT 1`);
        order.push("B-end");
        childBFinished = true;
      });
      releaseA();
      await childA;
      // 不在此 await B：外层节点本身必须负责排空子队列。
      void childB.catch(() => {});
      await tx.execute(sql`SELECT 1`);
      return "outer-result";
    });

    assertEquals(outer, "outer-result");
    assertEquals(childBFinished, true, "外层 savepoint 完成前必须排空子 B");
    assertEquals(order, ["A-begin", "A-end", "B-begin", "B-end"]);
    const rows = unwrapRows<{ ok: number }>(
      await db.execute(sql`SELECT 11 AS ok`) as never,
    );
    assertEquals(rows[0].ok, 11);
  },
});

Deno.test({
  name: "test-tx: 父事务失败先关闭并排空已开始的子队列，再回滚父 savepoint",
  ignore: !hasPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const order: string[] = [];
    const childTable = `test_tx_children_${
      crypto.randomUUID().replaceAll("-", "")
    }`;
    // 测试事务里建表，父 savepoint 回滚时只应回滚子事务写入的行。
    await db.execute(
      sql.raw(`CREATE TEMP TABLE ${childTable} (id text PRIMARY KEY)`),
    );
    const childAId = crypto.randomUUID();
    const childBId = crypto.randomUUID();
    const parentError = new Error("父回调原始异常");
    let releaseA: () => void = () => {};
    const aMayFinish = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let markEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let markLateSettled: () => void = () => {};
    const lateSettled = new Promise<void>((resolve) => {
      markLateSettled = resolve;
    });
    let lateError: unknown;

    const parent = db.transaction(async () => {
      void db.transaction(async (child) => {
        order.push("A-begin");
        markEntered();
        await aMayFinish;
        await child.execute(
          sql`INSERT INTO ${sql.raw(childTable)} (id) VALUES (${childAId})`,
        );
        order.push("A-end");
      }).catch(() => {});
      await entered;
      void db.transaction(async (child) => {
        order.push("B-begin");
        await child.execute(
          sql`INSERT INTO ${sql.raw(childTable)} (id) VALUES (${childBId})`,
        );
        order.push("B-end");
      }).catch(() => {});

      // 定时器继承父 ALS 上下文；父进入失败收尾并关闭节点后，该调用必须被拒绝。
      setTimeout(async () => {
        try {
          await db.transaction(async (child) => {
            await child.execute(sql`SELECT 1`);
          });
          lateError = new Error("迟到子事务意外执行");
        } catch (err) {
          lateError = err;
        } finally {
          markLateSettled();
        }
      }, 0);
      throw parentError;
    });
    const parentSettled = parent.then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );

    await lateSettled;
    releaseA();
    assert(lateError instanceof Error);
    assert(lateError.message.includes("父 savepoint 已结束"));
    const settled = await parentSettled;
    assert(settled.error === parentError, "应保留父回调的原始异常对象");
    assertEquals(order, ["A-begin", "A-end", "B-begin", "B-end"]);
    const childRows = unwrapRows<{ id: string }>(
      await db.execute(
        sql`SELECT id FROM ${
          sql.raw(childTable)
        } WHERE id IN (${childAId}, ${childBId})`,
      ) as never,
    );
    assertEquals(
      childRows,
      [],
      "父 savepoint 回滚必须一并移除成功子节点的写入",
    );
    const rows = unwrapRows<{ ok: number }>(
      await db.execute(sql`SELECT 13 AS ok`) as never,
    );
    assertEquals(rows[0].ok, 13, "父回滚后外层测试事务仍可用");
  },
});

Deno.test({
  name: "test-tx: 外层回调内 Promise.all 的两个内层事务按序执行且不死锁",
  ignore: !hasPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const order: string[] = [];
    const result = await db.transaction(async (tx) => {
      order.push("outer-begin");
      const [x, y] = await Promise.all([
        db.transaction(async (inner) => {
          order.push("inner-1-begin");
          await inner.execute(sql`SELECT 1`);
          order.push("inner-1-end");
          return "x";
        }),
        db.transaction(async (inner) => {
          order.push("inner-2-begin");
          await inner.execute(sql`SELECT 1`);
          order.push("inner-2-end");
          return "y";
        }),
      ]);
      await tx.execute(sql`SELECT 1`);
      order.push("outer-end");
      return `${x}${y}`;
    });
    assertEquals(result, "xy");
    assertEquals(order, [
      "outer-begin",
      "inner-1-begin",
      "inner-1-end",
      "inner-2-begin",
      "inner-2-end",
      "outer-end",
    ]);
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
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1`);
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
      const inner = await db.transaction(async (innerTx) => {
        events.push("inner");
        await innerTx.execute(sql`SELECT 1`);
        return "inner-value";
      });
      await tx.execute(sql`SELECT 1`);
      events.push("outer-end");
      return inner;
    });
    assertEquals(outer, "inner-value");
    assertEquals(events, ["outer-begin", "inner", "outer-end"]);
  },
});
