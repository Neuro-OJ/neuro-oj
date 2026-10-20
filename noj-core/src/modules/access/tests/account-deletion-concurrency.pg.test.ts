import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { getDb } from "../../../shared/db/connection.ts";
import * as schema from "../../../shared/db/schema.ts";
import { resetDbForTest } from "../../../../tests/helpers/db.ts";
import {
  domainMemberships,
  roles,
  userRoles,
  users,
} from "../../../shared/db/schema.ts";
import { adminDeleteAccountTx } from "../account.ts";
import { userActorFromAuthenticatedId } from "../contracts/actor.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");

function connection() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL 未设置");
  return postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
}

async function account(): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: id,
    email: `${id}@example.com`,
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function makeAdmin(userId: string): Promise<void> {
  const [role] = await getDb().select({ id: roles.id }).from(roles).where(
    eq(roles.name, "admin"),
  );
  await getDb().insert(userRoles).values({ user_id: userId, role_id: role.id });
}

async function waitBlocked(
  observer: ReturnType<typeof postgres>,
  waiting: number,
  blocker: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
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
  throw new Error("管理员注销未进入真实 PostgreSQL 行锁队列");
}

Deno.test({
  name: "账户注销并发 PG：两个管理员互删时行锁串行化最后管理员保护",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const first = await account();
    const second = await account();
    await makeAdmin(first);
    await makeAdmin(second);

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
    const boundary = {
      onMemberRemovedTx: async () => {},
      afterCommit: async () => {},
    };
    try {
      const [{ pid: firstPid }] = await clientA`
        SELECT pg_backend_pid() AS pid
      `;
      const [{ pid: secondPid }] = await clientB`
        SELECT pg_backend_pid() AS pid
      `;
      const firstDelete = dbA.transaction(async (tx) => {
        const result = await adminDeleteAccountTx(
          tx,
          userActorFromAuthenticatedId(first),
          second,
          boundary,
        );
        firstReady();
        await firstHeld;
        return result;
      });
      await firstLocked;
      const secondDelete = dbB.transaction((tx) =>
        adminDeleteAccountTx(
          tx,
          userActorFromAuthenticatedId(second),
          first,
          boundary,
        )
      );
      secondDelete.catch(() => {});
      await waitBlocked(observer, secondPid, firstPid);
      releaseFirst();
      await firstDelete;
      await assertRejects(() => secondDelete);

      const [firstRow, secondRow] = await Promise.all([
        getDb().select({ deletedAt: users.deleted_at }).from(users).where(
          eq(users.id, first),
        ),
        getDb().select({ deletedAt: users.deleted_at }).from(users).where(
          eq(users.id, second),
        ),
      ]);
      assertEquals(firstRow[0]?.deletedAt, null);
      assert(firstRow[0]?.deletedAt === null);
      assert(secondRow[0]?.deletedAt !== null);
      assertEquals(
        (await getDb().select().from(domainMemberships)).length,
        0,
      );
    } finally {
      releaseFirst();
      await Promise.allSettled([clientA.end(), clientB.end(), observer.end()]);
    }
  },
});
