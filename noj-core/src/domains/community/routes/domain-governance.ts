import { type Context, Hono } from "hono";
import { eq } from "drizzle-orm";
import { authMiddleware, type OptionalAuthEnv } from "../../identity/index.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { communityBoards } from "../../../shared/db/schema.ts";
import { loadWorkspace } from "../../workspace/index.ts";
import { withDomainCommunity } from "../services/community/domain-community.ts";
import {
  changeCommentStatus,
  changePostStatus,
  createBoard,
  createReport,
  createSanction,
  getPost,
  getReportDetail,
  listBoards,
  listPendingComments,
  listPosts,
  listReports,
  listSanctions,
  resolvePostId,
  resolveReport,
  revokeSanction,
  togglePostFlag,
  updateBoard,
} from "../services/community/community.ts";
import type { CommunityScope } from "../services/community/community-scope.ts";
const prefix = "/domains/:slug/community";
/** 域社区治理只管理目标域内容及域禁言，不提供平台账号或私信管理能力。 */
export const domainCommunityGovernanceRouter = new Hono<OptionalAuthEnv>();
for (
  const path of [
    `${prefix}/reports`,
    `${prefix}/reports/*`,
    `${prefix}/manage/*`,
  ]
) {
  domainCommunityGovernanceRouter.use(path, authMiddleware);
}
async function input<T>(c: Parameters<typeof parseJsonBody>[0]) {
  const body = await parseJsonBody<unknown>(c);
  assertObjectBody(body);
  return body as T;
}
function scope<T>(
  c: Context<OptionalAuthEnv>,
  write: boolean,
  operation: (s: CommunityScope) => Promise<T>,
  permission = "community:moderate",
) {
  return withDomainCommunity(c.req.param("slug")!, c.var.userId!, {
    write,
    permission,
  }, operation);
}
domainCommunityGovernanceRouter.post(`${prefix}/reports`, async (c) => {
  const body = await input<Parameters<typeof createReport>[1]>(c);
  return c.json({
    data: await scope(
      c,
      true,
      (s) => createReport(s.actorId!, body, s.moderator, s),
      "community:read",
    ),
  }, 201);
});
domainCommunityGovernanceRouter.get(
  `${prefix}/reports/:id`,
  async (c) =>
    c.json({
      data: await scope(
        c,
        false,
        (s) => getReportDetail(c.req.param("id")!, s.actorId!, s.moderator, s),
        "community:read",
      ),
    }),
);
domainCommunityGovernanceRouter.get(
  `${prefix}/manage/boards`,
  async (c) =>
    c.json({ data: await scope(c, false, (s) => listBoards(true, s)) }),
);
domainCommunityGovernanceRouter.post(`${prefix}/manage/boards`, async (c) => {
  const body = await input<Parameters<typeof createBoard>[0]>(c);
  if (
    typeof body.slug !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug) ||
    typeof body.name !== "string" || !body.name.trim()
  ) throw new BadRequestError("板块名称和 slug 无效");
  return c.json(
    { data: await scope(c, true, (s) => createBoard(body, s)) },
    201,
  );
});
domainCommunityGovernanceRouter.patch(
  `${prefix}/manage/boards/:id`,
  async (c) => {
    const body = await input<Parameters<typeof updateBoard>[1]>(c),
      raw = c.req.header("If-Match");
    if (!raw) {
      throw new AppError(
        "需要 If-Match 板块 revision",
        428,
        "REVISION_REQUIRED",
      );
    }
    const value = raw.replace(/^"|"$/g, "");
    if (!/^\d+$/.test(value)) throw new BadRequestError("revision 无效");
    return c.json({
      data: await scope(c, true, async (s) => {
        const current = (await listBoards(true, s)).find((b) =>
          b.id === c.req.param("id")
        );
        if (!current) throw new NotFoundError("板块不存在");
        const [locked] = await s.executor.select().from(communityBoards).where(
          eq(communityBoards.id, current.id),
        ).for("update");
        if (locked.revision !== Number(value)) {
          throw new ConflictError("板块已修改");
        }
        const result = await updateBoard(current.id, {
          name: body.name,
          description: body.description,
          sort_order: body.sort_order,
          is_archived: body.is_archived,
        }, s);
        await s.executor.update(communityBoards).set({
          revision: locked.revision + 1,
        }).where(eq(communityBoards.id, current.id));
        return { ...result, revision: locked.revision + 1 };
      }),
    });
  },
);
domainCommunityGovernanceRouter.get(
  `${prefix}/manage/posts`,
  async (c) =>
    c.json(
      await scope(
        c,
        false,
        (s) =>
          listPosts({
            viewerId: s.actorId!,
            moderator: true,
            scope: s,
            limit: 50,
          }),
      ),
    ),
);
domainCommunityGovernanceRouter.get(
  `${prefix}/manage/comments`,
  async (c) =>
    c.json({ data: await scope(c, false, (s) => listPendingComments(50, s)) }),
);
domainCommunityGovernanceRouter.patch(
  `${prefix}/manage/posts/:id/status`,
  async (c) => {
    const body = await input<
      { status: "published" | "hidden" | "deleted"; reason?: string }
    >(c);
    if (
      !["published", "hidden", "deleted"].includes(body.status)
    ) throw new BadRequestError("内容状态无效");
    return c.json({
      data: await scope(c, true, async (s) => {
        const id = await resolvePostId(c.req.param("id")!);
        await getPost(id, s.actorId!, true, s);
        return changePostStatus(id, s.actorId!, body.status, body.reason, s);
      }),
    });
  },
);
domainCommunityGovernanceRouter.patch(
  `${prefix}/manage/posts/:id/flags`,
  async (c) => {
    const body = await input<
      { field: "is_locked" | "is_pinned"; value: boolean }
    >(c);
    if (
      !["is_locked", "is_pinned"].includes(body.field) ||
      typeof body.value !== "boolean"
    ) throw new BadRequestError("标记无效");
    return c.json({
      data: await scope(c, true, async (s) => {
        const id = await resolvePostId(c.req.param("id")!);
        await getPost(id, s.actorId!, true, s);
        return togglePostFlag(id, s.actorId!, body.field, body.value, s);
      }),
    });
  },
);
domainCommunityGovernanceRouter.patch(
  `${prefix}/manage/comments/:id/status`,
  async (c) => {
    const body = await input<
      { status: "published" | "hidden" | "deleted"; reason?: string }
    >(c);
    if (
      !["published", "hidden", "deleted"].includes(body.status)
    ) throw new BadRequestError("评论状态无效");
    return c.json({
      data: await scope(c, true, (s) =>
        changeCommentStatus(
          c.req.param("id")!,
          s.actorId!,
          body.status,
          body.reason,
          s,
        )),
    });
  },
);
domainCommunityGovernanceRouter.get(
  `${prefix}/manage/reports`,
  async (c) =>
    c.json({ data: await scope(c, false, (s) => listReports("all", s)) }),
);
domainCommunityGovernanceRouter.patch(
  `${prefix}/manage/reports/:id`,
  async (c) => {
    const body = await input<
      { status: "resolved" | "dismissed"; resolution?: string }
    >(c);
    if (
      !["resolved", "dismissed"].includes(body.status)
    ) throw new BadRequestError("举报状态无效");
    return c.json({
      data: await scope(c, true, (s) =>
        resolveReport(
          c.req.param("id")!,
          s.actorId!,
          body.status,
          body.resolution,
          undefined,
          undefined,
          s,
        )),
    });
  },
);
domainCommunityGovernanceRouter.get(
  `${prefix}/manage/sanctions`,
  async (c) => c.json({ data: await scope(c, false, (s) => listSanctions(s)) }),
);
domainCommunityGovernanceRouter.post(
  `${prefix}/manage/sanctions`,
  async (c) => {
    const body = await input<
      { user_id: string; reason: string; expires_at?: string }
    >(c);
    if (
      typeof body.reason !== "string" || !body.reason.trim()
    ) throw new BadRequestError("禁言理由必填");
    return c.json({
      data: await scope(c, true, async (s) => {
        const user = await loadWorkspace(s.slug, body.user_id, {
          executor: s.executor,
        });
        if (!user.membership) throw new NotFoundError("域成员不存在");
        return createSanction(
          s.actorId!,
          body.user_id,
          body.reason,
          body.expires_at,
          s,
        );
      }),
    }, 201);
  },
);
domainCommunityGovernanceRouter.delete(
  `${prefix}/manage/sanctions/:id`,
  async (c) =>
    c.json({
      data: await scope(
        c,
        true,
        (s) => revokeSanction(s.actorId!, c.req.param("id")!, s),
      ),
    }),
);
