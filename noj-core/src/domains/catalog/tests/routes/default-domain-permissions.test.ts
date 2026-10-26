import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { createApp } from "../../../../app.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domainMemberRoles,
  domainMemberships,
  domainProblemBindings,
  problemBindingHistory,
} from "../../../../shared/db/schema.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { createDomain, DEFAULT_DOMAIN_ID } from "../../../workspace/index.ts";
import { createDomainProblem, createProblem } from "../../index.ts";
import {
  createDefaultCatalogToken,
  resetDbForTest,
} from "../default-fixture.ts";

Deno.test("默认题库权限：成员不能创建，编辑者可写本人草稿，撤销角色立即失效", async () => {
  await resetDbForTest();
  await initRedisForTest();
  const app = createApp();
  const input = { title: "统一题库", description: "题面", is_objective: true };
  const member = await createDefaultCatalogToken("member");
  assertEquals(
    (await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token: member,
      body: input,
    })).status,
    403,
  );
  const editor = await createDefaultCatalogToken("editor");
  const actor = decodeJwt(editor).sub!;
  const created = await createProblem(input, actor);
  for (
    const reference of [
      String(created.number),
      `P${created.number}`,
      created.id,
    ]
  ) {
    const res = await jsonRequest(app, `/api/v1/problems/${reference}/draft`, {
      token: editor,
    });
    assertEquals(res.status, 200);
  }
  assertEquals(
    (await jsonRequest(app, `/api/v1/problems/U${created.number}`, {
      token: editor,
    })).status,
    404,
  );
  assertEquals(
    (await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token: editor,
      body: { ...input, type: "P" },
    })).status,
    400,
  );
  const visibility = await jsonRequest(
    app,
    `/api/v1/problems/${created.id}/visibility`,
    {
      method: "PUT",
      token: editor,
      body: { visibility: "private" },
    },
  );
  assertEquals(visibility.status, 200);
  const [binding] = await getDb().select().from(domainProblemBindings).where(
    eq(domainProblemBindings.problem_id, created.id),
  );
  assertEquals(binding.visibility, "members");
  assertEquals(binding.revision, 1);
  const [history] = await getDb().select().from(problemBindingHistory).where(
    and(
      eq(problemBindingHistory.binding_id, binding.id),
      eq(problemBindingHistory.revision, 1),
    ),
  );
  assertEquals(history.actor_id, actor);
  assertEquals(history.reason.includes("members"), true);
  assertEquals(
    (await jsonRequest(app, `/api/v1/problems/${created.id}/visibility`, {
      method: "PUT",
      token: member,
      body: { visibility: "public" },
    })).status,
    403,
  );
  const [membership] = await getDb().select().from(domainMemberships).where(and(
    eq(domainMemberships.domain_id, DEFAULT_DOMAIN_ID),
    eq(domainMemberships.user_id, actor),
  ));
  await getDb().delete(domainMemberRoles).where(
    eq(domainMemberRoles.membership_id, membership.id),
  );
  assertEquals(
    (await jsonRequest(app, `/api/v1/problems/${created.id}/draft`, {
      token: editor,
    })).status,
    403,
  );
});

Deno.test("旧入口只读写 main：其他域真实资源 ID 不进入默认题面、草稿或支持包", async () => {
  await resetDbForTest();
  await initRedisForTest();
  const admin = await createDefaultCatalogToken("admin");
  const actor = decodeJwt(admin).sub!;
  const school = await createDomain({
    slug: "compat-school",
    name: "兼容测试学校",
    preset: "education",
  }, actor);
  const problem = await createDomainProblem(school.slug, {
    title: "学校私有题",
    description: "内部题面",
    is_objective: true,
  }, actor);
  const app = createApp();
  for (const suffix of ["", "/draft", "/support-package"]) {
    assertEquals(
      (await jsonRequest(app, `/api/v1/problems/${problem.id}${suffix}`, {
        token: admin,
      })).status,
      404,
    );
  }
  assertEquals(
    (await jsonRequest(app, `/api/v1/problems/${problem.id}`, {
      method: "PUT",
      token: admin,
      body: { title: "越域修改" },
      headers: { "If-Match": "1" },
    })).status,
    404,
  );
});
