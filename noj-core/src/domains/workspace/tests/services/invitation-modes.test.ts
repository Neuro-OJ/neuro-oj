import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { createUserToken } from "../../../../../tests/helper.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  domainInvitations,
  domainLimits,
} from "../../../../shared/db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  consumeDomainInvitation,
  createDomain,
  createDomainInvitation,
  previewDomainInvitation,
  revokeDomainInvitation,
} from "../../index.ts";

async function account(admin = false) {
  return decodeJwt(await createUserToken(admin ? "admin" : "user")).sub!;
}

Deno.test("多种邀请：通用码与链接共享人数，重复兑换不重复计数，最后名额原子消费", async () => {
  await resetDbForTest();
  const owner = await account(true),
    a = await account(),
    b = await account(),
    c = await account();
  const domain = await createDomain({
    slug: "shared-invites",
    name: "通用邀请",
    preset: "team",
  }, owner);
  const invite = await createDomainInvitation(domain.slug, owner, {
    mode: "general",
    max_uses: 2,
  });
  assertEquals(
    (await previewDomainInvitation(invite.code.toLowerCase())).max_uses,
    2,
  );
  await consumeDomainInvitation(invite.code, a);
  await consumeDomainInvitation(invite.token, a);
  const results = await Promise.allSettled([
    consumeDomainInvitation(invite.code, b),
    consumeDomainInvitation(invite.token, c),
  ]);
  assertEquals(results.filter((row) => row.status === "fulfilled").length, 1);
  const [stored] = await getDb().select().from(domainInvitations).where(
    eq(domainInvitations.id, invite.id),
  );
  assertEquals(stored.used_count, 2);
  assertEquals(stored.code_hash === invite.code, false);
  await assertRejects(
    () => previewDomainInvitation(invite.token),
    NotFoundError,
  );
  await consumeDomainInvitation(invite.token, a);
});

Deno.test("多种邀请：一次性不绑定邮箱，容量失败不消费，撤销与到期立即拒绝", async () => {
  await resetDbForTest();
  const owner = await account(true),
    user = await account(),
    other = await account();
  const domain = await createDomain({
    slug: "once-invites",
    name: "一次性邀请",
    preset: "team",
  }, owner);
  const invite = await createDomainInvitation(domain.slug, owner, {
    mode: "once",
  });
  await getDb().update(domainLimits).set({ members: 1 }).where(
    eq(domainLimits.domain_id, domain.id),
  );
  await assertRejects(
    () => consumeDomainInvitation(invite.code, user),
    ForbiddenError,
  );
  assertEquals((await previewDomainInvitation(invite.code)).used_count, 0);
  await getDb().update(domainLimits).set({ members: 2 }).where(
    eq(domainLimits.domain_id, domain.id),
  );
  await consumeDomainInvitation(invite.code, user);
  await assertRejects(
    () => consumeDomainInvitation(invite.token, other),
    NotFoundError,
  );
  const reusable = await createDomainInvitation(domain.slug, owner, {
    mode: "general",
  });
  await revokeDomainInvitation(domain.slug, owner, reusable.id);
  await assertRejects(
    () => consumeDomainInvitation(reusable.code, other),
    NotFoundError,
  );
  const expired = await createDomainInvitation(domain.slug, owner, {
    mode: "once",
  });
  await getDb().update(domainInvitations).set({
    expires_at: "2000-01-01T00:00:00Z",
  }).where(eq(domainInvitations.id, expired.id));
  await assertRejects(
    () => consumeDomainInvitation(expired.code, other),
    NotFoundError,
  );
  await assertRejects(
    () =>
      createDomainInvitation(domain.slug, owner, {
        mode: "general",
        max_uses: 0,
      }),
    BadRequestError,
  );
});
