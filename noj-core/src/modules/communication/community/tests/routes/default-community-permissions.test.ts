/**
 * 旧社区入口 `/api/v1/community/*`（固定默认域）的授权回归。
 *
 * #717 把 RBAC 角色表换成"平台角色静态能力"后，旧入口仍保留平台级
 * `community:create_*` / `community:comment` / `community:report` /
 * `community_moderation:review` 断言。这些能力只存在于**域有效角色**上，
 * 平台能力集合里没有 → 所有普通用户被 403（社区曾整体不可用），
 * 同时 `checkPermission` 误删了 `admin:full_access` 通配，平台管理员也失去
 * 管理端权限。
 *
 * 本文件锁定修复后的口径：
 * - 默认域成员的读写能力来自域内有效角色（member 即可发帖/评论/举报）；
 * - 非成员不能评论/举报（FORBIDDEN）；
 * - 普通成员不能删除他人内容（审核权只给 educator 及以上域角色）；
 * - 平台管理员经 `admin:full_access` 通配放行，`/config` 返回可写且 moderate。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { createApp } from "../../../../../app.ts";
import { getDb } from "../../../../../shared/db/connection.ts";
import { domainMemberships, users } from "../../../../../shared/db/schema.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../../shared/workspace/types.ts";
import {
  enterTestContext,
  initSystemSettings,
  leaveTestContext,
  resetSetting,
  updateSetting,
} from "../../../../platform/system/index.ts";
import { signToken } from "../../../../access/identity/services/security/jwt.ts";
import {
  createUserToken,
  jsonRequest,
} from "../../../../../../tests/helper.ts";
import { createBoard, withDefaultCommunity } from "../../index.ts";

const base = "/api/v1/community";

/** 板块 slug 在同一测试库内跨执行共享，必须唯一（唯一约束含 domain+slug）。 */
const boardSlug = `perm-regression-${crypto.randomUUID().slice(0, 8)}`;

/**
 * 打开社区开关并返回应用。
 *
 * **不能**在本文件里 `resetDbForTest()`：启动器的分片会把多个测试文件跑在同一
 * 个测试库进程里，任何一处 TRUNCATE 都会打断同进程其它文件（曾导致
 * `community.test.ts` 连续 `Cannot read properties of undefined`）。
 * 因此这里只做幂等的设置写入与按需插入，所有实体都用 UUID 标识。
 */
async function scopedApp() {
  await initSystemSettings();
  enterTestContext({ actorId: "0", actorIp: "127.0.0.1", actorRole: "admin" });
  try {
    // 实例模块政策可能被同分片的其它文件关闭社区，先恢复默认（全部开放）。
    await resetSetting("instance_allowed_modules", "0");
    await updateSetting("community_enabled", true, "0");
    await updateSetting("community_new_user_review_hours", 0, "0");
    await updateSetting("community_post_interval_seconds", 0, "0");
    await updateSetting("community_solutions_enabled", true, "0");
    await updateSetting("community_discussions_enabled", true, "0");
  } finally {
    leaveTestContext();
  }
  return createApp();
}

/** 建一个可登录的普通账号并返回其 id。 */
async function createUser(role: "user" | "admin" = "user") {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: `perm_${id.slice(0, 8)}`,
    email: `${id}@test.local`,
    password_hash: "x",
    must_change_password: false,
    role,
    created_at: now,
    updated_at: now,
  });
  return id;
}

/**
 * 加入默认域。
 *
 * 产品路径（邀请）要求邀请人具备 `domain:invitations`，而测试库默认域负责人是
 * 不可登录的系统用户；这里按 `ensureDefaultWorkspace` 的引导语义直接写入
 * active 成员行——社区授权只看 `domain_memberships` 的有效角色。
 */
async function joinDefaultDomain(
  userId: string,
  role: "member" | "educator" = "member",
): Promise<void> {
  await getDb().insert(domainMemberships).values({
    id: crypto.randomUUID(),
    domain_id: DEFAULT_DOMAIN_ID,
    user_id: userId,
    role,
    status: "active",
    joined_at: new Date().toISOString(),
  }).onConflictDoUpdate({
    target: [domainMemberships.domain_id, domainMemberships.user_id],
    set: { status: "active", role, left_at: null },
  });
}

/** 默认域板块（同一测试库内多个用例共用，slug 唯一）。 */
let fixtureBoard: string | null = null;
async function boardId(): Promise<string> {
  if (fixtureBoard) return fixtureBoard;
  const board = await withDefaultCommunity(
    "0",
    { write: true, moderator: true },
    (scope) => createBoard({ slug: boardSlug, name: "权限回归板块" }, scope),
  );
  fixtureBoard = board.id;
  return board.id;
}

async function token(userId: string, role: "user" | "admin" = "user") {
  return await signToken({ sub: userId, role });
}

async function createDiscussion(
  app: ReturnType<typeof createApp>,
  accessToken: string,
) {
  const res = await jsonRequest(app, `${base}/posts`, {
    method: "POST",
    token: accessToken,
    body: {
      type: "discussion",
      board_id: await boardId(),
      title: "权限回归帖子",
      content: "正文",
    },
  });
  assertEquals(
    res.status,
    201,
    `发帖失败：${res.status} ${await res.clone().text()}`,
  );
  return (await res.json() as { data: { id: string } }).data.id;
}

Deno.test({
  name: "默认域社区：成员可发帖/评论/举报，/config 下发可写能力",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const app = await scopedApp();
    const memberId = await createUser();
    await joinDefaultDomain(memberId);
    const memberToken = await token(memberId);

    const config = await jsonRequest(app, `${base}/config`, {
      token: memberToken,
    });
    assertEquals(config.status, 200);
    const permissions = (await config.json() as {
      data: { permissions: Record<string, boolean> };
    }).data.permissions;
    assertEquals(permissions.comment, true);
    assertEquals(permissions.report, true);
    assertEquals(permissions.solution, true);
    assertEquals(permissions.moderate, false, "成员不应显示审核入口");

    const postId = await createDiscussion(app, memberToken);

    const comment = await jsonRequest(app, `${base}/posts/${postId}/comments`, {
      method: "POST",
      token: memberToken,
      body: { content: "成员评论" },
    });
    assertEquals(
      comment.status,
      201,
      `评论失败：${comment.status} ${await comment.clone().text()}`,
    );

    const report = await jsonRequest(app, `${base}/reports`, {
      method: "POST",
      token: memberToken,
      body: { post_id: postId, category: "垃圾信息", reason: "垃圾内容" },
    });
    assertEquals(
      report.status,
      201,
      `举报失败：${report.status} ${await report.clone().text()}`,
    );
  },
});

Deno.test({
  name: "默认域社区：非成员不能评论或举报",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const app = await scopedApp();
    const authorId = await createUser();
    await joinDefaultDomain(authorId);
    const postId = await createDiscussion(app, await token(authorId));

    const outsiderId = await createUser();
    const outsiderToken = await token(outsiderId);

    const comment = await jsonRequest(app, `${base}/posts/${postId}/comments`, {
      method: "POST",
      token: outsiderToken,
      body: { content: "域外用户评论" },
    });
    assertEquals(comment.status, 403);

    const report = await jsonRequest(app, `${base}/reports`, {
      method: "POST",
      token: outsiderToken,
      body: { post_id: postId, category: "垃圾信息", reason: "垃圾内容" },
    });
    assertEquals(report.status, 403);
  },
});

Deno.test({
  name: "默认域社区：普通成员不能删除他人内容",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const app = await scopedApp();
    const authorId = await createUser();
    await joinDefaultDomain(authorId);
    const postId = await createDiscussion(app, await token(authorId));

    // 必须是 member：educator 及以上域角色本就有审核权，用它断言 403 就是错的。
    const otherId = await createUser();
    await joinDefaultDomain(otherId, "member");
    const [row] = await getDb().select({ role: domainMemberships.role }).from(
      domainMemberships,
    ).where(and(
      eq(domainMemberships.domain_id, DEFAULT_DOMAIN_ID),
      eq(domainMemberships.user_id, otherId),
    ));
    assert(row?.role === "member", "夹具必须是非审核员成员");

    const res = await jsonRequest(app, `${base}/posts/${postId}`, {
      method: "DELETE",
      token: await token(otherId),
    });
    assertEquals(
      res.status,
      403,
      `普通成员不应能删除他人内容：${res.status} ${await res.clone().text()}`,
    );
  },
});

Deno.test({
  name: "平台管理员通配：旧入口 /config 返回可写且具备审核标志",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const app = await scopedApp();
    const adminToken = await createUserToken("admin");
    const res = await jsonRequest(app, `${base}/config`, { token: adminToken });
    assertEquals(res.status, 200);
    const permissions = (await res.json() as {
      data: { permissions: Record<string, boolean> };
    }).data.permissions;
    assertEquals(permissions.discussion, true);
    assertEquals(permissions.moderate, true);
  },
});
