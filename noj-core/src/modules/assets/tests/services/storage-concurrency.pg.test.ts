import { assert, assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import type { DbRoot } from "../../../../shared/db/executor.ts";
import { domainLimits } from "../../../../shared/db/schema.ts";
import * as schema from "../../../../shared/db/schema.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import { createUserToken } from "../../../../../tests/helper.ts";
import { verifyToken } from "../../../../domains/identity/index.ts";
import { userActorFromAuthenticatedId } from "../../../access/contracts/actor.ts";
import { updateSetting } from "../../../platform/index.ts";
import {
  getDomainStorageUsage,
  reserveDomainStorageUpload,
} from "../../services/storage-quota.ts";
import {
  createDomain,
  ensureDefaultWorkspace,
} from "../../../../domains/workspace/index.ts";

function connection() {
  return postgres(Deno.env.get("DATABASE_URL")!, {
    max: 1,
    onnotice: () => {},
  });
}

Deno.test({
  name: "存储容量 PG: 两个物理连接竞争最后容量只有一个预约成功",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const actor = await verifyToken(await createUserToken());
    await ensureDefaultWorkspace();
    await updateSetting(
      "domain_creation_policy",
      "open",
      userActorFromAuthenticatedId(actor.sub),
      undefined,
      { ipAddress: "assets-test" },
    );
    const domain = await createDomain({
      slug: "storage-race",
      name: "学校",
      preset: "education",
    }, actor.sub);
    await getDb().update(domainLimits).set({ storage_bytes: 10 }).where(
      eq(domainLimits.domain_id, domain.id),
    );
    const first = connection(), second = connection(), blocker = connection();
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const [one] = await first`SELECT pg_backend_pid() AS pid`;
      const [two] = await second`SELECT pg_backend_pid() AS pid`;
      assert(one.pid !== two.pid);
      await blocker.unsafe("BEGIN");
      await blocker`SELECT domain_id FROM domain_resource_counters WHERE domain_id=${domain.id} AND resource='storage_bytes' FOR UPDATE`;
      pending = Promise.allSettled([
        reserveDomainStorageUpload(
          { domainId: domain.id, bytes: 8 },
          drizzle(first, { schema }) as unknown as DbRoot,
        ),
        reserveDomainStorageUpload(
          { domainId: domain.id, bytes: 8 },
          drizzle(second, { schema }) as unknown as DbRoot,
        ),
      ]);
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const [row] =
          await blocker`SELECT cardinality(pg_blocking_pids(${one.pid}::int))>0 AND cardinality(pg_blocking_pids(${two.pid}::int))>0 AS blocked`;
        if (row.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(blocked, "两个独立连接必须实际进入 PostgreSQL 行锁队列");
      await blocker.unsafe("COMMIT");
      const results = await pending;
      assertEquals(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const rejected = results.find((result) =>
        result.status === "rejected"
      ) as PromiseRejectedResult;
      assert(rejected.reason instanceof AppError);
      assertEquals(rejected.reason.code, "DOMAIN_STORAGE_LIMIT");
      assertEquals(await getDomainStorageUsage(domain.id), {
        used: 0,
        reserved: 8,
      });
    } finally {
      await blocker.unsafe("ROLLBACK");
      await pending;
      await Promise.all([first.end(), second.end(), blocker.end()]);
    }
  },
});
