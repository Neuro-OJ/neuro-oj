import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { AppError } from "../../../../../shared/base/errors.ts";
import {
  domains,
  permissions,
  rolePermissions,
  roles,
  userRoles,
} from "../../../../../shared/db/schema.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../../shared/workspace/types.ts";
import adminCommunityRouter from "../../../../http/admin/routes/community.ts";
import { signToken } from "../../../../access/identity/index.ts";
import { addDomainMember } from "../../../../access/workspace/index.ts";
import {
  createBoard,
  createPost,
  createReport,
  withDefaultCommunity,
  withDomainCommunity,
} from "../../index.ts";
import { jsonRequest } from "../../../../../../tests/helper.ts";
import { domainFixture } from "../services/domain-fixture.ts";
import { updateSetting } from "../../../../platform/system/index.ts";

const base = "/api/v1/admin/community";

async function fixture() {
  const f = await domainFixture("mod-scope");
  const app = new Hono();
  app.route(base, adminCommunityRouter);
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(
        { error: error.message, code: error.code },
        error.statusCode as 400,
      );
    }
    throw error;
  });
  const roleId = crypto.randomUUID();
  await f.db.insert(roles).values({
    id: roleId,
    name: roleId,
    created_at: f.now,
    updated_at: f.now,
  });
  const [permission] = await f.db.select().from(permissions).where(and(
    eq(permissions.resource, "community_moderation"),
    eq(permissions.action, "review"),
  ));
  await f.db.insert(rolePermissions).values({
    role_id: roleId,
    permission_id: permission.id,
  });
  await f.db.insert(userRoles).values({ user_id: f.student, role_id: roleId });
  const token = await signToken({ sub: f.student, role: "user" });
  const board = await withDefaultCommunity(
    "0",
    { write: true, moderator: true },
    (scope) =>
      createBoard({ slug: "moderation-test", name: "main board" }, scope),
  );
  const post = await withDefaultCommunity(
    "0",
    { write: true, moderator: true },
    (scope) =>
      createPost(
        "0",
        {
          type: "discussion",
          board_id: board.id,
          title: "main content",
          content: "main snapshot",
        },
        true,
        scope,
      ),
  );
  const report = await createReport(f.a, {
    post_id: post.id,
    reason: "main report",
    category: "其他",
  }, true);
  const privateReport = await withDomainCommunity(
    f.target.slug,
    f.student,
    { write: true },
    (scope) =>
      createReport(
        f.student,
        { post_id: f.postB.id, reason: "private report", category: "其他" },
        true,
        scope,
      ),
  );
  const [main] = await f.db.select().from(domains).where(
    eq(domains.id, DEFAULT_DOMAIN_ID),
  );
  return { ...f, app, token, main, report, privateReport };
}

Deno.test({
  name: "旧治理 HTTP：main 私有时举报入口拒绝",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture();
    await f.db.update(domains).set({
      configuration: { ...f.main.configuration, access: "members" },
    }).where(eq(domains.id, f.main.id));
    assertEquals(
      (await jsonRequest(f.app, `${base}/reports`, { token: f.token })).status,
      404,
    );
    assertEquals(
      (await jsonRequest(f.app, `${base}/reports/${f.report.id}/dismissed`, {
        token: f.token,
        method: "POST",
        body: { resolution: "reviewed" },
      })).status,
      404,
    );
  },
});

Deno.test({
  name: "旧治理 HTTP：main 授权后只含 main 举报，跨域举报不可读写",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture();
    await addDomainMember(f.db, f.main.id, f.student);
    await f.db.update(domains).set({
      configuration: { ...f.main.configuration, access: "members" },
    }).where(eq(domains.id, f.main.id));
    const reports = await jsonRequest(f.app, `${base}/reports`, {
      token: f.token,
    });
    assertEquals(reports.status, 200);
    assertEquals(
      (await reports.json()).data.map((row: { report: { id: string } }) =>
        row.report.id
      ),
      [f.report.id],
    );
    assertEquals(
      (await jsonRequest(
        f.app,
        `${base}/reports/${f.privateReport.id}/dismissed`,
        { token: f.token, method: "POST", body: { resolution: "cross" } },
      )).status,
      404,
    );
    assertEquals(
      (await jsonRequest(f.app, `${base}/reports/${f.report.id}/resolved`, {
        token: f.token,
        method: "POST",
        body: { resolution: "main action" },
      })).status,
      200,
    );
  },
});

Deno.test({
  name: "旧治理 HTTP：实例关闭社区时阻断内容治理",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture();
    await updateSetting(
      "instance_allowed_modules",
      JSON.stringify({
        community: false,
        classroom: true,
        assignment: true,
        analytics: true,
      }),
      "0",
    );
    const response = await jsonRequest(f.app, `${base}/reports`, {
      token: f.token,
    });
    assertEquals(response.status, 403);
    assertEquals((await response.json()).code, "DOMAIN_MODULE_DISABLED");
    assertEquals(
      (await jsonRequest(f.app, `${base}/reports/${f.report.id}/dismissed`, {
        token: f.token,
        method: "POST",
        body: { resolution: "disabled" },
      })).status,
      403,
    );
  },
});
