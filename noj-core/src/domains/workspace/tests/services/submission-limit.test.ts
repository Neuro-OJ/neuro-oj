import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { domainLimits } from "../../../../shared/db/schema.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import { connectRedis, getRedis } from "../../../../shared/mq/connection.ts";
import { createUserToken } from "../../../../../tests/helper.ts";
import { verifyToken } from "../../../identity/index.ts";
import { updateSetting } from "../../../system/index.ts";
import { createDomain, ensureDefaultWorkspace } from "../../index.ts";
import { consumeDomainSubmissionQuota } from "../../services/submission-limit.ts";

Deno.test({
  name: "域提交频率: 两用户竞争末个额度、重试幂等、不同域独立、实时降低上限",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await resetDbForTest();
    const actor = (await verifyToken(await createUserToken())).sub;
    await ensureDefaultWorkspace();
    await updateSetting("domain_creation_policy", "open", "0");
    const a = await createDomain({
      slug: "rate-a",
      name: "A",
      preset: "education",
    }, actor);
    const b = await createDomain({
      slug: "rate-b",
      name: "B",
      preset: "education",
    }, actor);
    await getDb().update(domainLimits).set({ submissions_per_minute: 1 }).where(
      eq(domainLimits.domain_id, a.id),
    );
    await getDb().update(domainLimits).set({ submissions_per_minute: 2 }).where(
      eq(domainLimits.domain_id, b.id),
    );
    await connectRedis();
    const operations = [crypto.randomUUID(), crypto.randomUUID()];
    const results = await Promise.allSettled([
      consumeDomainSubmissionQuota(a.id, actor, operations[0]),
      consumeDomainSubmissionQuota(a.id, "second-user", operations[1]),
    ]);
    assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
    const winner = results.findIndex((r) => r.status === "fulfilled");
    await consumeDomainSubmissionQuota(
      a.id,
      winner === 0 ? actor : "second-user",
      operations[winner],
    );
    await consumeDomainSubmissionQuota(b.id, actor, operations[0]);
    await getDb().update(domainLimits).set({ submissions_per_minute: 1 }).where(
      eq(domainLimits.domain_id, b.id),
    );
    const exceeded = await assertRejects(
      () => consumeDomainSubmissionQuota(b.id, actor, crypto.randomUUID()),
      AppError,
    );
    assertEquals(exceeded.statusCode, 429);
    const redis = getRedis();
    redis.disconnect();
    const unavailable = await assertRejects(
      () => consumeDomainSubmissionQuota(b.id, actor, crypto.randomUUID()),
      AppError,
    );
    assertEquals(unavailable.code, "DOMAIN_SUBMISSION_QUOTA_UNAVAILABLE");
    assertEquals(unavailable.statusCode, 503);
    await getDb().update(domainLimits).set({ submissions_per_minute: null })
      .where(eq(domainLimits.domain_id, b.id));
    await consumeDomainSubmissionQuota(b.id, actor, crypto.randomUUID());
    await connectRedis();
  },
});
