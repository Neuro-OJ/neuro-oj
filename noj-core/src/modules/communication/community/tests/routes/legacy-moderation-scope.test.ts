import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { AppError } from "../../../../../shared/base/errors.ts";
import {
  conversations,
  domains,
  messages,
  permissions,
  rolePermissions,
  roles,
  userRoles,
} from "../../../../../shared/db/schema.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../../shared/workspace/types.ts";
import adminCommunityRouter from "../../../../http/admin/routes/community.ts";
import { enqueueReview } from "../../../review/index.ts";
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
  const conversationId = crypto.randomUUID(), messageId = crypto.randomUUID();
  const [user1, user2] = [f.a, f.student].sort();
  await f.db.insert(conversations).values({
    id: conversationId,
    user1_id: user1,
    user2_id: user2,
    last_message_at: f.now,
    created_at: f.now,
  });
  await f.db.insert(messages).values({
    id: messageId,
    conversation_id: conversationId,
    sender_id: f.a,
    content: "account private message",
    created_at: f.now,
  });
  const messageReport = await createReport(f.student, {
    message_id: messageId,
    reason: "message report",
    category: "其他",
  }, true);
  const review = async (
    targetId: string,
    domainId: string | null,
    message = false,
  ) => {
    const row = await enqueueReview({
      target_id: targetId,
      content_type: message ? "message" : "post",
      channel: message ? "dm" : "ugc",
      status: "pending_review",
      review_provider: "mock",
      verdict: "review",
      content_snapshot: `snapshot ${targetId}`,
      meta: domainId ? { domain_id: domainId } : {},
    });
    return row!;
  };
  const mainReview = await review(post.id, DEFAULT_DOMAIN_ID);
  // 目标的真实域优先于元数据；错误的 main 元数据不能覆盖私域归属。
  const privateReview = await review(f.postB.id, DEFAULT_DOMAIN_ID);
  const mainOrphan = await review(crypto.randomUUID(), DEFAULT_DOMAIN_ID);
  const privateOrphan = await review(crypto.randomUUID(), f.target.id);
  const unknownOrphan = await review(crypto.randomUUID(), null);
  const messageReview = await review(messageId, null, true);
  const [main] = await f.db.select().from(domains).where(
    eq(domains.id, DEFAULT_DOMAIN_ID),
  );
  return {
    ...f,
    app,
    token,
    main,
    report,
    privateReport,
    messageReport,
    mainReview,
    privateReview,
    mainOrphan,
    privateOrphan,
    unknownOrphan,
    messageReview,
  };
}

Deno.test({
  name: "旧治理 HTTP：main 私有时混合入口拒绝，账号私信专项读写独立",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture();
    await f.db.update(domains).set({
      configuration: { ...f.main.configuration, access: "members" },
    }).where(eq(domains.id, f.main.id));
    for (
      const path of [
        "/reports",
        "/content-review",
        `/content-review/${f.mainReview.id}`,
      ]
    ) {
      assertEquals(
        (await jsonRequest(f.app, `${base}${path}`, { token: f.token })).status,
        404,
        path,
      );
    }
    for (
      const path of [
        `/reports/${f.report.id}/dismissed`,
        `/content-review/${f.mainReview.id}/reviewed`,
      ]
    ) {
      assertEquals(
        (await jsonRequest(f.app, `${base}${path}`, {
          token: f.token,
          method: "POST",
          body: { resolution: "reviewed" },
        })).status,
        404,
        path,
      );
    }
    const reports = await jsonRequest(
      f.app,
      `${base}/reports?content_type=message`,
      { token: f.token },
    );
    assertEquals(reports.status, 200);
    assertEquals(
      (await reports.json()).data.map((row: { report: { id: string } }) =>
        row.report.id
      ),
      [f.messageReport.id],
    );
    for (const query of ["channel=dm", "content_type=message"]) {
      const response = await jsonRequest(
        f.app,
        `${base}/content-review?${query}`,
        { token: f.token },
      );
      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.pagination.total, 1);
      assertEquals(body.data[0].id, f.messageReview.id);
    }
    assertEquals(
      (await jsonRequest(
        f.app,
        `${base}/content-review/${f.messageReview.id}`,
        { token: f.token },
      )).status,
      200,
    );
    for (const status of ["dismissed", "reopen", "resolved"]) {
      assertEquals(
        (await jsonRequest(
          f.app,
          `${base}/reports/${f.messageReport.id}/${status}`,
          {
            token: f.token,
            method: "POST",
            body: { resolution: "account action" },
          },
        )).status,
        200,
        status,
      );
    }
    assertEquals(
      (await jsonRequest(
        f.app,
        `${base}/content-review/${f.messageReview.id}/reviewed`,
        {
          token: f.token,
          method: "POST",
          body: { resolution: "account action" },
        },
      )).status,
      200,
    );
  },
});

Deno.test({
  name: "旧治理 HTTP：main 授权后分页只含 main 与消息，跨域或未知归属不可读写",
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
      ).sort(),
      [f.report.id, f.messageReport.id].sort(),
    );
    const response = await jsonRequest(
      f.app,
      `${base}/content-review?per_page=1`,
      { token: f.token },
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.data.length, 1);
    assertEquals(body.pagination.total, 3);
    assertEquals(body.pagination.total_pages, 3);
    assertEquals(
      (await jsonRequest(f.app, `${base}/content-review/${f.mainOrphan.id}`, {
        token: f.token,
      })).status,
      200,
    );
    for (const row of [f.privateReview, f.privateOrphan, f.unknownOrphan]) {
      assertEquals(
        (await jsonRequest(f.app, `${base}/content-review/${row.id}`, {
          token: f.token,
        })).status,
        404,
      );
      assertEquals(
        (await jsonRequest(
          f.app,
          `${base}/content-review/${row.id}/dismissed`,
          { token: f.token, method: "POST", body: { resolution: "cross" } },
        )).status,
        404,
      );
    }
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
    assertEquals(
      (await jsonRequest(
        f.app,
        `${base}/content-review/${f.mainReview.id}/reviewed`,
        { token: f.token, method: "POST", body: { resolution: "main action" } },
      )).status,
      200,
    );
  },
});

Deno.test({
  name: "旧治理 HTTP：实例关闭社区只阻断内容治理，私信治理保持可用",
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
    for (
      const path of [
        "/reports",
        "/content-review",
        `/content-review/${f.mainReview.id}`,
      ]
    ) {
      const response = await jsonRequest(f.app, `${base}${path}`, {
        token: f.token,
      });
      assertEquals(response.status, 403, path);
      assertEquals((await response.json()).code, "DOMAIN_MODULE_DISABLED");
    }
    assertEquals(
      (await jsonRequest(f.app, `${base}/reports/${f.report.id}/dismissed`, {
        token: f.token,
        method: "POST",
        body: { resolution: "disabled" },
      })).status,
      403,
    );
    for (
      const path of [
        "/reports?content_type=message",
        "/content-review?channel=dm",
        `/content-review/${f.messageReview.id}`,
      ]
    ) {
      assertEquals(
        (await jsonRequest(f.app, `${base}${path}`, { token: f.token })).status,
        200,
        path,
      );
    }
    assertEquals(
      (await jsonRequest(
        f.app,
        `${base}/reports/${f.messageReport.id}/dismissed`,
        { token: f.token, method: "POST", body: { resolution: "account" } },
      )).status,
      200,
    );
    assertEquals(
      (await jsonRequest(
        f.app,
        `${base}/content-review/${f.messageReview.id}/reviewed`,
        { token: f.token, method: "POST", body: { resolution: "account" } },
      )).status,
      200,
    );
  },
});
