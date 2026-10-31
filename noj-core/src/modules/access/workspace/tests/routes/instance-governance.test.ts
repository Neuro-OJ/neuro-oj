import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { createApp } from "../../../../../app.ts";
import { getDb } from "../../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import {
  auditLogs,
  domainResourceCounters,
  roles,
  userRoles,
  users,
} from "../../../../../shared/db/schema.ts";
import { signToken } from "../../../identity/index.ts";
import { updateSetting } from "../../../../platform/system/index.ts";
import {
  createDomain,
  requestDomainCreation,
  setDomainStatus,
} from "../../index.ts";
import { reserveDomainStorageUpload } from "../../../../assets/index.ts";
import { jsonRequest } from "../../../../../../tests/helper.ts";

async function account(admin = false) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: id,
    email: `${id}@example.com`,
    email_verified: true,
    created_at: now,
    updated_at: now,
  });
  if (admin) {
    const [role] = await getDb().select().from(roles).where(
      eq(roles.name, "admin"),
    );
    await getDb().insert(userRoles).values({ user_id: id, role_id: role.id });
  }
  return {
    id,
    token: await signToken({ sub: id, role: admin ? "admin" : "user" }),
  };
}

Deno.test("实例治理 HTTP：平台目录能分页查私有暂停域，域负责人不能读取平台目录", async () => {
  await resetDbForTest();
  const platform = await account(true);
  const owner = await account();
  await updateSetting("domain_creation_policy", "open", platform.id);
  const school = await createDomain({
    slug: "governance-school",
    name: "治理学校",
    preset: "education",
  }, owner.id);
  const other = await createDomain({
    slug: "governance-team",
    name: "治理团队",
    preset: "team",
  }, owner.id);
  await setDomainStatus(school.slug, platform.id, "suspended", school.revision);
  const app = createApp();
  assertEquals(
    (await jsonRequest(app, "/api/v1/admin/instance/domains", {
      token: owner.token,
    })).status,
    403,
  );
  const page = await jsonRequest(
    app,
    "/api/v1/admin/instance/domains?keyword=治理&per_page=1&page=2",
    { token: platform.token },
  );
  assertEquals(page.status, 200);
  assertEquals(page.headers.get("Cache-Control"), "no-store");
  const body = await page.json();
  assertEquals(body.pagination, {
    page: 2,
    per_page: 1,
    total: 2,
    total_pages: 2,
  });
  assertEquals(body.data.length, 1);
  const filtered = await (await jsonRequest(
    app,
    "/api/v1/admin/instance/domains?status=suspended",
    { token: platform.token },
  )).json();
  assertEquals(filtered.data[0].id, school.id);
  assertEquals(filtered.data[0].owner_username, owner.id);
  assertEquals(filtered.data[0].revision, 1);
  assertEquals(filtered.data[0].configuration.access, "members");
  const resumed = await jsonRequest(
    app,
    `/api/v1/domains/${school.slug}/status`,
    {
      method: "POST",
      token: platform.token,
      headers: { "If-Match": "1" },
      body: { status: "active" },
    },
  );
  assertEquals(resumed.status, 200);
  assertEquals((await resumed.json()).data.id, school.id);
  assertEquals(
    (await jsonRequest(app, "/api/v1/admin/instance/domains?status=deleted", {
      token: platform.token,
    })).status,
    400,
  );
  assertEquals(
    (await jsonRequest(app, "/api/v1/admin/instance/domains?page=0", {
      token: platform.token,
    })).status,
    400,
  );
  assertEquals(other.status, "active");
});

Deno.test("创建审核 HTTP：按状态分页展示申请人，批准拒绝均审计明确申请目标", async () => {
  await resetDbForTest();
  const platform = await account(true);
  const applicant = await account();
  const deleted = await account();
  await updateSetting("domain_creation_policy", "approval", platform.id);
  const first = await requestDomainCreation(applicant.id, {
    slug: "approve-school",
    name: "批准学校",
    preset: "education",
    reason: "教学",
  });
  const second = await requestDomainCreation(applicant.id, {
    slug: "reject-school",
    name: "拒绝学校",
    preset: "education",
    reason: "教学",
  });
  const historic = await requestDomainCreation(deleted.id, {
    slug: "deleted-school",
    name: "历史申请",
    preset: "education",
    reason: "教学",
  });
  await getDb().update(users).set({ deleted_at: new Date().toISOString() })
    .where(eq(users.id, deleted.id));
  const app = createApp();
  assertEquals(
    (await jsonRequest(app, "/api/v1/admin/instance/domain-creation-requests", {
      token: applicant.token,
    })).status,
    403,
  );
  const page = await (await jsonRequest(
    app,
    "/api/v1/admin/instance/domain-creation-requests?status=pending&per_page=1&page=2",
    { token: platform.token },
  )).json();
  assertEquals(page.pagination, {
    page: 2,
    per_page: 1,
    total: 3,
    total_pages: 3,
  });
  assertEquals(page.data.length, 1);
  for (const [request, approved] of [[first, true], [second, false]] as const) {
    const response = await jsonRequest(
      app,
      `/api/v1/admin/instance/domain-creation-requests/${request.id}/review`,
      { method: "POST", token: platform.token, body: { approved } },
    );
    assertEquals(response.status, 200);
    const [audit] = await getDb().select().from(auditLogs).where(
      and(
        eq(auditLogs.target_type, "domain_creation_request"),
        eq(auditLogs.target_id, request.id),
      ),
    );
    assertEquals(audit.admin_id, platform.id);
    assertEquals((audit.detail as Record<string, unknown>).approved, approved);
    assertEquals(
      (audit.detail as Record<string, unknown>).requested_slug,
      request.slug,
    );
    assertEquals(
      (audit.detail as Record<string, unknown>).operation,
      "creation_request_review",
    );
  }
  const remaining = await (await jsonRequest(
    app,
    "/api/v1/admin/instance/domain-creation-requests?status=pending",
    { token: platform.token },
  )).json();
  assertEquals(remaining.pagination.total, 1);
  assertEquals(remaining.data[0].id, historic.id);
  assertEquals(remaining.data[0].applicant_username, "已注销用户");
  assertEquals(remaining.data[0].applicant_deleted, true);
  const duplicate = await jsonRequest(
    app,
    `/api/v1/admin/instance/domain-creation-requests/${second.id}/review`,
    { method: "POST", token: platform.token, body: { approved: false } },
  );
  assertEquals(duplicate.status, 409);
  assertEquals(
    (await getDb().select().from(auditLogs).where(
      eq(auditLogs.target_id, second.id),
    )).length,
    1,
  );
  assertEquals(
    (await jsonRequest(
      app,
      "/api/v1/admin/instance/domain-creation-requests?status=invalid",
      { token: platform.token },
    )).status,
    400,
  );
});

Deno.test("域配额 HTTP：当前成员题库计数与上传预留可读，错误域及普通成员不能读取", async () => {
  await resetDbForTest();
  const platform = await account(true);
  const owner = await account();
  const stranger = await account();
  await updateSetting("domain_creation_policy", "open", platform.id);
  const school = await createDomain({
    slug: "quota-usage-school",
    name: "学校",
    preset: "education",
  }, owner.id);
  const other = await createDomain({
    slug: "quota-usage-other",
    name: "其他",
    preset: "education",
  }, stranger.id);
  await getDb().update(domainResourceCounters).set({ used: 2, reserved: 1 })
    .where(
      and(
        eq(domainResourceCounters.domain_id, school.id),
        eq(domainResourceCounters.resource, "problems"),
      ),
    );
  await reserveDomainStorageUpload({ domainId: school.id, bytes: 12 });
  const app = createApp();
  const read = await jsonRequest(app, `/api/v1/domains/${school.slug}/limits`, {
    token: owner.token,
  });
  assertEquals(read.status, 200);
  const { data } = await read.json();
  assertEquals(data.usage, {
    members: 1,
    problems: 2,
    storage_bytes: 0,
    reserved_members: 0,
    reserved_problems: 1,
    reserved_storage_bytes: 12,
  });
  assertEquals(data.revision, 0);
  assertEquals(
    (await jsonRequest(app, `/api/v1/domains/${other.slug}/limits`, {
      token: owner.token,
    })).status,
    404,
  );
  assertEquals(
    (await jsonRequest(app, `/api/v1/domains/${school.slug}/limits`, {
      token: stranger.token,
    })).status,
    404,
  );
});
