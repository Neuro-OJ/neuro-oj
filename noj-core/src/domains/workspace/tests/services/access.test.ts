import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  domains,
  roles,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../../../shared/base/errors.ts";
import {
  assertDomainFeatureEnabled,
  createDomain,
  loadWorkspace,
  presetConfiguration,
  setMemberRole,
  updateDomain,
} from "../../index.ts";
import { loadDomainForJoining } from "../../services/access.ts";
import type { DomainRole } from "../../../../shared/workspace/types.ts";

async function owner() {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: id,
    email: `${id}@example.com`,
    created_at: now,
    updated_at: now,
  });
  const [role] = await getDb().select().from(roles).where(
    eq(roles.name, "admin"),
  );
  await getDb().insert(userRoles).values({ user_id: id, role_id: role.id });
  return id;
}

Deno.test("授权配置：导航及无关模块异常不阻断读取，访问与目标模块仍严格验证", async () => {
  await resetDbForTest();
  const actor = await owner();
  const domain = await createDomain({
    slug: "navigation-config",
    name: "学校",
    preset: "education",
  }, actor);
  const configuration = Object.assign(presetConfiguration("education"), {
    homepage: "broken",
  });
  Object.assign(configuration.features, { analytics: "broken" });
  await getDb().update(domains).set({ configuration }).where(
    eq(domains.id, domain.id),
  );
  const loaded = await loadWorkspace(domain.slug, actor);
  assertEquals(loaded.domain.id, domain.id);
  await assertDomainFeatureEnabled(loaded.domain, "assignment");
  await assertDomainFeatureEnabled(loaded.domain, "analytics");
  await assertRejects(() => loadWorkspace(domain.slug, null), NotFoundError);
  await assertRejects(
    () => updateDomain(domain.slug, actor, 0, { configuration }),
    BadRequestError,
  );

  Object.assign(configuration, { access: "broken" });
  await getDb().update(domains).set({ configuration }).where(
    eq(domains.id, domain.id),
  );
  await assertRejects(
    () => loadWorkspace(domain.slug, actor),
    ServiceUnavailableError,
  );
  await assertRejects(
    () => loadWorkspace(domain.slug, null),
    ServiceUnavailableError,
  );
});

Deno.test("加入及角色写入：只检查相应输入边界，不因首页错误阻断合法加入政策", async () => {
  await resetDbForTest();
  const actor = await owner();
  const domain = await createDomain({
    slug: "joining-config",
    name: "社区",
    preset: "community",
  }, actor);
  const configuration = Object.assign(presetConfiguration("community"), {
    homepage: "broken",
  });
  await getDb().update(domains).set({ configuration }).where(
    eq(domains.id, domain.id),
  );
  assertEquals((await loadDomainForJoining(domain.slug)).id, domain.id);
  await assertRejects(
    () =>
      setMemberRole(domain.slug, actor, actor, "system:admin" as DomainRole),
    BadRequestError,
  );
  Object.assign(configuration, { join_policy: "broken" });
  await getDb().update(domains).set({ configuration }).where(
    eq(domains.id, domain.id),
  );
  assertEquals((await loadWorkspace(domain.slug, null)).domain.id, domain.id);
  await assertRejects(
    () => loadDomainForJoining(domain.slug),
    ServiceUnavailableError,
  );

  Object.assign(configuration, {
    features: {
      community: true,
      classroom: false,
      assignment: true,
      analytics: false,
    },
  });
  await getDb().update(domains).set({ configuration }).where(
    eq(domains.id, domain.id),
  );
  const loaded = await loadWorkspace(domain.slug, actor);
  await assertDomainFeatureEnabled(loaded.domain, "community");
  await assertRejects(
    () => assertDomainFeatureEnabled(loaded.domain, "assignment"),
    ForbiddenError,
  );
});
