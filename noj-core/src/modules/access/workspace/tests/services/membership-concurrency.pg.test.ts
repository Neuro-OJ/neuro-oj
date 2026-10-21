import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDb } from "../../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import { unwrapRows } from "../../../../../shared/base/sql-rows.ts";
import {
  domainInvitations,
  domainLimits,
  domainMemberships,
  domainResourceCounters,
  roles,
  userRoles,
  users,
} from "../../../../../shared/db/schema.ts";
import { adminDeleteAccount } from "../../../identity/index.ts";
import { userActorFromAuthenticatedId } from "../../../contracts/actor.ts";
import {
  consumeDomainInvitation,
  createDomain,
  createDomainInvitation,
  joinDomain,
  reviewJoinRequest,
  updateDomain,
} from "../../index.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 独立物理连接，不能用单连接业务池的排队冒充 PostgreSQL 行锁。 */
function connection() {
  return postgres(DATABASE_URL!, {
    max: 1,
    onnotice: () => {},
  });
}

async function account(admin = false) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: id,
    email: `${id}@example.com`,
    created_at: now,
    updated_at: now,
  });
  if (admin) {
    const [role] = await getDb().select().from(roles).where(
      eq(roles.name, "admin"),
    );
    await getDb().insert(userRoles).values({ user_id: id, role_id: role.id });
  }
  return id;
}

async function fixture(kind: "join" | "invitation" | "approval") {
  await resetDbForTest();
  const owner = await account(true);
  const target = await account();
  const domain = await createDomain({
    slug: "membership-race",
    name: "学校",
    preset: "community",
  }, owner);
  let run: () => Promise<unknown> = () => joinDomain(domain.slug, target);
  if (kind === "invitation") {
    const invitation = await createDomainInvitation(
      domain.slug,
      owner,
      `${target}@example.com`,
    );
    run = () => consumeDomainInvitation(invitation.token, target);
  }
  if (kind === "approval") {
    await updateDomain(domain.slug, owner, domain.revision, {
      configuration: { ...domain.configuration, join_policy: "approval" },
    });
    const { request } = await joinDomain(domain.slug, target, "申请加入");
    run = () => reviewJoinRequest(domain.slug, request!.id, owner, true);
  }
  return { owner, target, domain, run };
}

/** 观察数据库锁依赖链，包含先到等待者的队列阻塞，不以连接池排队冒充。 */
async function waitBlocked(
  observer: ReturnType<typeof postgres>,
  waiting: number,
  blocker: number,
) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [row] = await observer`
      WITH RECURSIVE blockers(pid) AS (
        SELECT unnest(pg_blocking_pids(${waiting}::int))
        UNION
        SELECT unnest(pg_blocking_pids(blockers.pid)) FROM blockers
      ) SELECT EXISTS(SELECT 1 FROM blockers WHERE pid = ${blocker}::int) AS blocked
    `;
    if (row.blocked) return;
    await sleep(10);
  }
  throw new Error("操作未进入真实 PostgreSQL 行锁队列");
}

for (const kind of ["join", "invitation", "approval"] as const) {
  Deno.test({
    name:
      `成员并发 PG：${kind} 在注销已持账号锁时不抢域锁、不留下已注销的有效成员`,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      const { target, domain, run } = await fixture(kind);
      const blocker = connection();
      const observer = connection();
      let pending: Promise<{ error?: unknown }> | undefined;
      try {
        const [{ pid: blockerPid }] =
          await blocker`SELECT pg_backend_pid() AS pid`;
        const [core] = unwrapRows<{ pid: number }>(
          await getDb().execute(sql`SELECT pg_backend_pid() AS pid`) as never,
        );
        await blocker.unsafe("BEGIN");
        await blocker`SELECT id FROM users WHERE id = ${target} FOR UPDATE`;
        pending = run().then(() => ({}), (error) => ({ error }));
        await waitBlocked(observer, core.pid, blockerPid);
        // 正确顺序应等在账号上，另一个连接仍可取得域锁。
        await observer.begin(async (tx) => {
          await tx`SELECT id FROM domains WHERE id = ${domain.id} FOR UPDATE NOWAIT`;
        });
        await blocker`UPDATE users SET deleted_at = ${
          new Date().toISOString()
        } WHERE id = ${target}`;
        await blocker.unsafe("COMMIT");
        const result = await pending;
        assert(result.error instanceof Error, "注销先提交时成员操作必须拒绝");
        const active = await getDb().select().from(domainMemberships).where(
          and(
            eq(domainMemberships.user_id, target),
            eq(domainMemberships.status, "active"),
          ),
        );
        assertEquals(active.length, 0);
        const [counter] = await getDb().select().from(domainResourceCounters)
          .where(
            and(
              eq(domainResourceCounters.domain_id, domain.id),
              eq(domainResourceCounters.resource, "members"),
            ),
          );
        assertEquals(counter.used, 1);
      } finally {
        await blocker.unsafe("ROLLBACK").catch(() => {});
        await pending?.catch(() => {});
        await Promise.all([blocker.end(), observer.end()]);
      }
    },
  });

  Deno.test({
    name: `成员并发 PG：${kind} 等待域锁时持有账号锁，先加入后注销正确释放名额`,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      const { owner, target, domain, run } = await fixture(kind);
      const blocker = connection();
      const observer = connection();
      let pending: Promise<unknown> | undefined;
      try {
        const [{ pid: blockerPid }] =
          await blocker`SELECT pg_backend_pid() AS pid`;
        const [core] = unwrapRows<{ pid: number }>(
          await getDb().execute(sql`SELECT pg_backend_pid() AS pid`) as never,
        );
        await blocker.unsafe("BEGIN");
        await blocker`SELECT id FROM domains WHERE id = ${domain.id} FOR UPDATE`;
        pending = run();
        // 为失败路径提前登记处理器，finally 仍会回收真实结果。
        pending.catch(() => {});
        await waitBlocked(observer, core.pid, blockerPid);
        const lockError = await assertRejects(() =>
          observer.begin(async (tx) => {
            await tx`SELECT id FROM users WHERE id = ${target} FOR UPDATE NOWAIT`;
          })
        );
        assertEquals((lockError as unknown as { code: string }).code, "55P03");
        await blocker.unsafe("COMMIT");
        await pending;
        await adminDeleteAccount(target, userActorFromAuthenticatedId(owner));
        const [history] = await getDb().select().from(domainMemberships).where(
          and(
            eq(domainMemberships.domain_id, domain.id),
            eq(domainMemberships.user_id, target),
          ),
        );
        assertEquals(history.status, "removed");
        const [counter] = await getDb().select().from(domainResourceCounters)
          .where(
            and(
              eq(domainResourceCounters.domain_id, domain.id),
              eq(domainResourceCounters.resource, "members"),
            ),
          );
        assertEquals(counter.used, 1);
      } finally {
        await blocker.unsafe("ROLLBACK").catch(() => {});
        await pending?.catch(() => {});
        await Promise.all([blocker.end(), observer.end()]);
      }
    },
  });
}

Deno.test({
  name: "成员并发 PG：两个独立连接竞争最后一个名额，仅成功一次且失败不消费邀请",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { owner, domain } = await fixture("join");
    const first = await account();
    const second = await account();
    await getDb().insert(domainLimits).values({
      domain_id: domain.id,
      members: 2,
    }).onConflictDoUpdate({
      target: domainLimits.domain_id,
      set: { members: 2 },
    });
    const invites = await Promise.all(
      [first, second].map((id) =>
        createDomainInvitation(domain.slug, owner, `${id}@example.com`)
      ),
    );
    const clients = [connection(), connection()];
    const blocker = connection();
    const observer = connection();
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const [{ pid: blockerPid }] =
        await blocker`SELECT pg_backend_pid() AS pid`;
      const pids = await Promise.all(
        clients.map(async (client) =>
          (await client`SELECT pg_backend_pid() AS pid`)[0].pid as number
        ),
      );
      await blocker.unsafe("BEGIN");
      await blocker`SELECT id FROM domains WHERE id = ${domain.id} FOR UPDATE`;
      pending = Promise.allSettled(
        clients.map((client, index) =>
          drizzle(client).transaction((tx) =>
            consumeDomainInvitation(
              invites[index].token,
              [first, second][index],
              tx,
            )
          )
        ),
      );
      await Promise.all(
        pids.map((pid) => waitBlocked(observer, pid, blockerPid)),
      );
      await blocker.unsafe("COMMIT");
      const results = await pending;
      assertEquals(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const failure = results.find((result) =>
        result.status === "rejected"
      ) as PromiseRejectedResult;
      assertEquals(failure.reason.code, "DOMAIN_MEMBER_LIMIT");
      const saved = await getDb().select().from(domainInvitations).where(
        eq(domainInvitations.domain_id, domain.id),
      );
      assertEquals(saved.filter((invite) => invite.used_at).length, 1);
      assertEquals(saved.filter((invite) => !invite.used_at).length, 1);
      const active = await getDb().select().from(domainMemberships).where(
        and(
          eq(domainMemberships.domain_id, domain.id),
          eq(domainMemberships.status, "active"),
        ),
      );
      assertEquals(active.length, 2);
    } finally {
      await blocker.unsafe("ROLLBACK").catch(() => {});
      await pending?.catch(() => {});
      await Promise.all([
        ...clients.map((client) => client.end()),
        blocker.end(),
        observer.end(),
      ]);
    }
  },
});
