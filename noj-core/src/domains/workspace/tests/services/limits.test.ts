import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  ServiceUnavailableError,
  ValidationError,
} from "../../../../shared/base/errors.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  domainLimits,
  roles,
  systemSettings,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import {
  allowedDomainFeatures,
  unlimitedDomainLimits,
} from "../../../../shared/workspace/resource-policy.ts";
import { updateSetting } from "../../../system/index.ts";
import {
  assertDomainFeatureEnabled,
  consumeDomainInvitation,
  createDomain,
  createDomainInvitation,
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
  getDomainEffectiveLimits,
  getInstancePolicy,
  joinDomain,
  setMemberRoles,
  updateDomain,
  updateDomainLimits,
} from "../../index.ts";

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

Deno.test("配额政策：新域复制默认值并受上限约束，默认域及存量域不被新默认覆盖", async () => {
  await resetDbForTest();
  const platform = await account(true);
  await ensureDefaultWorkspace();
  await updateSetting(
    "domain_default_limits",
    JSON.stringify({ ...unlimitedDomainLimits(), members: 2, problems: 10 }),
    platform,
  );
  await updateSetting(
    "domain_limit_caps",
    JSON.stringify({ ...unlimitedDomainLimits(), problems: 5 }),
    platform,
  );
  const domain = await createDomain({
    slug: "limited-school",
    name: "学校",
    preset: "community",
  }, platform);
  const initial = await getDomainEffectiveLimits(domain.id);
  assertEquals(initial.configured.members, 2);
  assertEquals(initial.effective.problems, 5);
  const [defaultLimits] = await getDb().select().from(domainLimits).where(
    eq(domainLimits.domain_id, DEFAULT_DOMAIN_ID),
  );
  assertEquals(defaultLimits.members, null);
  assertEquals(defaultLimits.problems, null);
  await updateSetting(
    "domain_default_limits",
    JSON.stringify({ ...unlimitedDomainLimits(), members: 100 }),
    platform,
  );
  assertEquals(
    (await getDomainEffectiveLimits(domain.id)).configured.members,
    2,
  );
  const member = await account();
  await joinDomain(domain.slug, member);
  await assertRejects(
    async () => await joinDomain(domain.slug, await account()),
    ForbiddenError,
  );
  await updateSetting(
    "domain_limit_caps",
    JSON.stringify({ ...unlimitedDomainLimits(), members: 1, problems: 3 }),
    platform,
  );
  assertEquals(
    (await getDomainEffectiveLimits(domain.id)).effective.members,
    1,
  );
  assertEquals(
    (await getDomainEffectiveLimits(domain.id)).effective.problems,
    3,
  );
});

Deno.test("配额治理：管理员只能降低，平台可提高；revision、实例上限和错误域继续检查", async () => {
  await resetDbForTest();
  const platform = await account(true);
  const manager = await account();
  const domain = await createDomain({
    slug: "quota-school",
    name: "学校",
    preset: "education",
  }, platform);
  const invite = await createDomainInvitation(
    domain.slug,
    platform,
    `${manager}@example.com`,
  );
  await consumeDomainInvitation(invite.token, manager);
  await setMemberRoles(domain.slug, platform, manager, ["admin"]);
  // 成员角色修改不修改域配置 revision，当前仍为 0。
  const lowered = await updateDomainLimits(domain.slug, manager, 0, {
    ...unlimitedDomainLimits(),
    members: 2,
  });
  assertEquals(lowered.revision, 1);
  await assertRejects(
    () =>
      updateDomainLimits(domain.slug, manager, 1, {
        ...unlimitedDomainLimits(),
        members: 3,
      }),
    ForbiddenError,
  );
  await assertRejects(
    () =>
      updateDomainLimits(domain.slug, manager, 0, {
        ...unlimitedDomainLimits(),
        members: 1,
      }),
    ConflictError,
  );
  await updateSetting(
    "domain_limit_caps",
    JSON.stringify({ ...unlimitedDomainLimits(), members: 4 }),
    platform,
  );
  await assertRejects(
    () =>
      updateDomainLimits(domain.slug, platform, 1, {
        ...unlimitedDomainLimits(),
        members: 5,
      }),
    ForbiddenError,
  );
  const raised = await updateDomainLimits(domain.slug, platform, 1, {
    ...unlimitedDomainLimits(),
    members: 4,
  });
  assertEquals(raised.effective.members, 4);
});

Deno.test("模块政策：受限 Preset、禁止重新启用及历史教学读取例外", async () => {
  await resetDbForTest();
  const platform = await account(true);
  const modules = {
    ...allowedDomainFeatures(),
    classroom: false,
    assignment: false,
    analytics: false,
  };
  await updateSetting(
    "instance_allowed_modules",
    JSON.stringify(modules),
    platform,
  );
  const domain = await createDomain({
    slug: "module-school",
    name: "学校",
    preset: "education",
  }, platform);
  assertEquals(domain.configuration.features.classroom, false);
  assertEquals(domain.configuration.homepage, "overview");
  assertEquals(getInstancePolicy().modules, modules);
  await assertRejects(
    () => assertDomainFeatureEnabled(domain, "assignment"),
    ForbiddenError,
  );
  await assertDomainFeatureEnabled(domain, "assignment", {
    historicalRead: true,
  });
  const disabled = await assertRejects(
    () =>
      assertDomainFeatureEnabled(domain, "assignment", {
        disabledCode: "MODULE_DISABLED",
      }),
    ForbiddenError,
  );
  assertEquals(disabled.code, "MODULE_DISABLED");
  await assertRejects(
    () =>
      updateDomain(domain.slug, platform, 0, {
        configuration: {
          ...domain.configuration,
          features: { ...domain.configuration.features, classroom: true },
        },
      }),
    ForbiddenError,
  );
});

Deno.test("结构化设置：错误格式不持久化；异常持久上限不会放宽执行", async () => {
  await resetDbForTest();
  const platform = await account(true);
  await assertRejects(
    () =>
      updateSetting(
        "domain_limit_caps",
        JSON.stringify({ ...unlimitedDomainLimits(), members: -1 }),
        platform,
      ),
    ValidationError,
  );
  await assertRejects(
    () => updateSetting("instance_allowed_modules", "{}", platform),
    ValidationError,
  );
  const domain = await createDomain({
    slug: "invalid-policy",
    name: "学校",
    preset: "community",
  }, platform);
  await getDb().insert(systemSettings).values({
    key: "domain_limit_caps",
    value: JSON.stringify(
      JSON.stringify({ ...unlimitedDomainLimits(), members: -1 }),
    ),
    updated_at: new Date().toISOString(),
    updated_by: platform,
  });
  await assertRejects(
    () => getDomainEffectiveLimits(domain.id),
    ServiceUnavailableError,
  );
  await assertRejects(
    async () => await joinDomain(domain.slug, await account()),
    ServiceUnavailableError,
  );
});
Deno.test("配额不变量：显式 null 不限额，缺少配额记录不能静默放宽", async () => {
  await resetDbForTest();
  const platform = await account(true);
  await ensureDefaultWorkspace();
  const domain = await createDomain({
    slug: "missing-limits",
    name: "学校",
    preset: "community",
  }, platform);
  assertEquals(
    (await getDomainEffectiveLimits(DEFAULT_DOMAIN_ID)).configured,
    unlimitedDomainLimits(),
  );
  assertEquals(
    (await getDomainEffectiveLimits(domain.id)).effective,
    unlimitedDomainLimits(),
  );
  await getDb().delete(domainLimits).where(
    eq(domainLimits.domain_id, domain.id),
  );
  const error = await assertRejects(
    () => getDomainEffectiveLimits(domain.id),
    AppError,
  );
  assertEquals(error.code, "DOMAIN_LIMITS_MISSING");
  assertEquals(error.statusCode, 500);
  await assertRejects(
    async () => await joinDomain(domain.slug, await account()),
    AppError,
    "工作空间配额未初始化",
  );
  const [missing] = await getDb().select().from(domainLimits).where(
    eq(domainLimits.domain_id, domain.id),
  );
  assertEquals(missing, undefined);
});

Deno.test("实例政策解析：JSON 解析原因只包装一次，响应不包含原配置", async () => {
  await resetDbForTest();
  const platform = await account(true);
  const domain = await createDomain({
    slug: "invalid-policy-json",
    name: "学校",
    preset: "community",
  }, platform);
  await getDb().insert(systemSettings).values({
    key: "domain_limit_caps",
    value: "private-value-not-json",
    updated_at: new Date().toISOString(),
    updated_by: platform,
  });
  const error = await assertRejects(
    () => getDomainEffectiveLimits(domain.id),
    ServiceUnavailableError,
  );
  assert(error.cause instanceof SyntaxError);
  assertEquals(error.message, "实例资源政策无效，请联系管理员修复");
  assertEquals(error.meta, undefined);
});
