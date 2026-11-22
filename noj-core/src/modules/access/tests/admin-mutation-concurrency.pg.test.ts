/**
 * 管理员变更并发回归：真实 PostgreSQL 双连接 + 锁依赖屏障。
 *
 * 覆盖降权与平台封禁两条会减少“可用管理员”的写入口，验证它们共用同一把事务级
 * 管理员锁：无论哪个事务先提交，第二个写入口都必须在锁内重新读取操作者身份或
 * 可用管理员数量并拒绝，最终至少保留一个可用管理员。不使用 sleep 猜测时序，
 * 也不依赖进程内锁。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { getDb } from "../../../shared/db/connection.ts";
import * as schema from "../../../shared/db/schema.ts";
import { resetDbForTest } from "../../../../tests/helpers/db.ts";
import { users } from "../../../shared/db/schema.ts";
import { countAvailableAdminsTx, setPlatformRoleTx } from "../admin-policy.ts";
import { banUser } from "../identity/services/users/users-bans.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");

function connection() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL 未设置");
  return postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
}

async function account(role: "admin" | "user" = "admin"): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: id,
    email: `${id}@example.com`,
    role,
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function waitBlocked(
  observer: ReturnType<typeof postgres>,
  waiting: number,
  blocker: number,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const [row] = await observer`
      WITH RECURSIVE blockers(pid) AS (
        SELECT unnest(pg_blocking_pids(${waiting}::int))
        UNION
        SELECT unnest(pg_blocking_pids(blockers.pid)) FROM blockers
      )
      SELECT EXISTS(SELECT 1 FROM blockers WHERE pid = ${blocker}::int) AS blocked
    `;
    if (row.blocked) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("管理员变更未进入真实 PostgreSQL 锁队列");
}

async function availableAdmins(): Promise<number> {
  return await getDb().transaction((tx) => countAvailableAdminsTx(tx));
}

Deno.test({
  name: "管理员并发 PG：两个管理员并发互相降权只成功一个",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const first = await account();
    const second = await account();
    const clientA = connection();
    const clientB = connection();
    const observer = connection();
    const dbA = drizzlePg(clientA, { schema });
    const dbB = drizzlePg(clientB, { schema });
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstReady!: () => void;
    const firstLocked = new Promise<void>((resolve) => {
      firstReady = resolve;
    });
    try {
      const [{ pid: firstPid }] = await clientA`SELECT pg_backend_pid() AS pid`;
      const [{ pid: secondPid }] =
        await clientB`SELECT pg_backend_pid() AS pid`;
      const firstDemote = dbA.transaction(async (tx) => {
        const result = await setPlatformRoleTx(tx, {
          actorId: first,
          targetUserId: second,
          role: "user",
        });
        firstReady();
        await firstHeld;
        return result;
      });
      await firstLocked;
      const secondDemote = dbB.transaction((tx) =>
        setPlatformRoleTx(tx, {
          actorId: second,
          targetUserId: first,
          role: "user",
        })
      );
      secondDemote.catch(() => {});
      await waitBlocked(observer, secondPid, firstPid);
      releaseFirst();
      await firstDemote;
      await assertRejects(() => secondDemote);

      const firstRow = await getDb().select({ role: users.role }).from(users)
        .where(eq(users.id, first));
      assertEquals(firstRow[0]?.role, "admin");
      const secondRow = await getDb().select({ role: users.role }).from(users)
        .where(eq(users.id, second));
      assertEquals(secondRow[0]?.role, "user");
      assert(await availableAdmins() >= 1);
    } finally {
      releaseFirst();
      await Promise.allSettled([clientA.end(), clientB.end(), observer.end()]);
    }
  },
});

Deno.test({
  name: "管理员并发 PG：并发平台封禁两个管理员只成功一个",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const first = await account();
    const second = await account();
    // 两个封禁各自开启真实事务并在锁内重读可用管理员数量；无论调度顺序如何，
    // 第二个必须因 LAST_ADMIN 被拒绝，实例不会变成零可用管理员。
    const results = await Promise.allSettled([
      banUser(first, "并发封禁 A", null, "0", "platform"),
      banUser(second, "并发封禁 B", null, "0", "platform"),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assertEquals(fulfilled.length, 1);
    assertEquals(rejected.length, 1);
    const reason = rejected[0]!.reason as { status?: number; code?: string };
    assertEquals(reason.status, 409);
    assertEquals(reason.code, "LAST_ADMIN");
    assert(await availableAdmins() >= 1);
  },
});
