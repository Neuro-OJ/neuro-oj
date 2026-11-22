import { assert, assertRejects } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { assertOwnedTestDatabase } from "../../../tests/helpers/db.ts";
import {
  createRawClient,
  withRawClient,
  withRawTransaction,
} from "../../../tests/helper/pg-raw-connection.ts";

function advisoryKey(): number {
  return Math.floor(Math.random() * 2_000_000_000) + 1;
}

Deno.test({
  name: "真实 PostgreSQL：withRawTransaction 异常会回滚事务锁",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertOwnedTestDatabase();
    const key = advisoryKey();
    const failure = new Error("rollback probe");
    await assertRejects(
      () =>
        withRawTransaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${key})`);
          throw failure;
        }),
      Error,
      "rollback probe",
    );

    // 事务回滚释放了 advisory xact lock；另一个物理连接必须立即取得它。
    await withRawClient(async (client) => {
      await client`SET lock_timeout = '500ms'`;
      await client`SELECT pg_advisory_xact_lock(${key})`;
    });
  },
});

Deno.test({
  name: "真实 PostgreSQL：独立物理连接确实进入行锁等待队列",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertOwnedTestDatabase();
    const key = advisoryKey();
    const holder = createRawClient();
    const waiter = createRawClient();
    const observer = createRawClient();
    let pending: Promise<unknown> | undefined;
    let holderInTransaction = false;
    let waiterInTransaction = false;
    try {
      await holder.unsafe("BEGIN");
      holderInTransaction = true;
      await holder`SELECT pg_advisory_xact_lock(${key})`;
      await waiter.unsafe("BEGIN");
      waiterInTransaction = true;
      await waiter.unsafe("SET LOCAL lock_timeout = '5s'");
      const [pidRow] = await waiter`SELECT pg_backend_pid() AS pid`;
      const waiterPid = Number(pidRow.pid);
      // postgres.js tagged query 是 thenable；用立即执行 async 函数确保查询在
      // observer 轮询前已经发到第二条物理连接，而不是等到最后 await 才开始。
      pending = (async () => {
        await waiter`SELECT pg_advisory_xact_lock(${key})`;
      })();
      let blocked = false;
      for (let attempt = 0; attempt < 500; attempt++) {
        const [row] = await observer`
          SELECT cardinality(pg_blocking_pids(${waiterPid}::int)) > 0 AS blocked
        `;
        if (row.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(blocked, "第二条物理连接必须进入 PostgreSQL 锁等待队列");
      await holder.unsafe("COMMIT");
      holderInTransaction = false;
      await pending;
      await waiter.unsafe("COMMIT");
      waiterInTransaction = false;
    } finally {
      if (holderInTransaction) await holder.unsafe("ROLLBACK").catch(() => {});
      if (waiterInTransaction) await waiter.unsafe("ROLLBACK").catch(() => {});
      await pending?.catch(() => {});
      await Promise.all([holder.end(), waiter.end(), observer.end()]);
    }
  },
});
