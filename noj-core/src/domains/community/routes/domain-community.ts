import { type Context, Hono } from "hono";
import {
  authMiddleware,
  type OptionalAuthEnv,
  optionalAuthMiddleware,
} from "../../identity/index.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import {
  BadRequestError,
  ForbiddenError,
} from "../../../shared/base/errors.ts";
import { withDomainCommunity } from "../services/community/domain-community.ts";
import {
  changePostStatus,
  countPostsByType,
  createComment,
  createPost,
  deleteComment,
  getCommunityConfig,
  getNotification,
  getNotificationUnreadCount,
  getPost,
  hasAcceptedSolution,
  listBoards,
  listBookmarks,
  listComments,
  listFeed,
  listNotifications,
  listPosts,
  markNotificationRead,
  markNotificationsRead,
  resolvePostId,
  setPostOfficial,
  toggleBookmark,
  toggleCommentLike,
  togglePostLike,
  updateComment,
  updatePost,
} from "../services/community/community.ts";
import { parseQueryLimit } from "../services/community/query-limit.ts";
import type {
  CommunityPostInput,
  CommunityPostType,
} from "../types/community.ts";
import { resolveCommunityProblem } from "../services/community/community-scope.ts";
import { domainCommunityGovernanceRouter } from "./domain-governance.ts";
import { domainCommunitySse } from "./sse.ts";
import { hasUnendedPublicContest } from "../../contest/index.ts";
import {
  enforceBookmarkRateLimit,
  enforceCommentLikeRateLimit,
  enforcePostLikeRateLimit,
  enforceReportRateLimit,
} from "../../system/index.ts";

/** 显式域社区入口，每次操作重新检查本域成员及内容授权。 */
export const domainCommunityRouter = new Hono<OptionalAuthEnv>();
const prefix = "/domains/:slug/community";
domainCommunityRouter.use(`${prefix}/*`, optionalAuthMiddleware);
domainCommunityRouter.use(`${prefix}/*`, async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.method === "POST" && c.var.userId) {
    const path = c.req.path, actorId = c.var.userId;
    if (/\/posts\/[^/]+\/like$/.test(path)) {
      await enforcePostLikeRateLimit(c, actorId);
    } else if (/\/comments\/[^/]+\/like$/.test(path)) {
      await enforceCommentLikeRateLimit(c, actorId);
    } else if (/\/posts\/[^/]+\/bookmark$/.test(path)) {
      await enforceBookmarkRateLimit(c, actorId);
    } else if (path.endsWith("/reports")) {
      await enforceReportRateLimit(c, actorId);
    }
  }
  await next();
});
domainCommunityRouter.route("/", domainCommunitySse);
type C = Context<OptionalAuthEnv>;
async function input<T>(c: Parameters<typeof parseJsonBody>[0]) {
  const value = await parseJsonBody<unknown>(c);
  assertObjectBody(value);
  return value as T;
}
function type(value: string | undefined) {
  if (value && !["solution", "discussion", "moment"].includes(value)) {
    throw new BadRequestError("无效内容类型");
  }
  return value as CommunityPostType | undefined;
}
function query(value: string | undefined) {
  if (value && value.length > 100) {
    throw new BadRequestError("搜索关键词最多 100 个字符");
  }
  return value?.trim();
}
function read<T>(
  c: C,
  operation: Parameters<typeof withDomainCommunity<T>>[3],
) {
  return withDomainCommunity(
    c.req.param("slug")!,
    c.var.userId ?? null,
    {},
    operation,
  );
}
function write<T>(
  c: C,
  permission: string,
  operation: Parameters<typeof withDomainCommunity<T>>[3],
  allowSocialBan = false,
) {
  return withDomainCommunity(c.req.param("slug")!, c.var.userId!, {
    write: true,
    permission,
    allowSocialBan,
  }, operation);
}
domainCommunityRouter.get(
  `${prefix}/config`,
  async (c) =>
    c.json({
      data: await read(c, async (s) => ({
        ...getCommunityConfig(),
        domain_id: s.domainId,
        permissions: {
          solution: s.member,
          discussion: s.member,
          moment: s.member,
          comment: s.member,
          react: s.member,
          follow: s.actorId !== null,
          report: s.member,
          moderate: s.moderator,
        },
        contest_silence: !s.moderator &&
          await hasUnendedPublicContest(s.domainId, s.executor),
      })),
    }),
);
domainCommunityRouter.get(
  `${prefix}/boards`,
  async (c) => c.json({ data: await read(c, (s) => listBoards(false, s)) }),
);
domainCommunityRouter.get(
  `${prefix}/posts`,
  async (c) =>
    c.json(
      await read(c, (s) =>
        listPosts({
          type: type(c.req.query("type")),
          query: query(c.req.query("q")),
          problemId: c.req.query("problem_id"),
          boardId: c.req.query("board_id"),
          authorId: c.req.query("author_id"),
          cursor: c.req.query("cursor"),
          limit: parseQueryLimit(c.req.query("limit"), { default: 20 }),
          viewerId: s.actorId ?? undefined,
          moderator: s.moderator,
          scope: s,
        })),
    ),
);
domainCommunityRouter.get(
  `${prefix}/posts/counts`,
  async (c) => c.json({ data: await read(c, (s) => countPostsByType(s)) }),
);
domainCommunityRouter.post(`${prefix}/posts`, authMiddleware, async (c) => {
  const body = await input<CommunityPostInput>(c);
  if (!type(body.type) || typeof body.content !== "string") {
    throw new BadRequestError("帖子类型和正文必填");
  }
  return c.json({
    data: await write(
      c,
      "community:create",
      (s) => createPost(s.actorId!, body, s.moderator, s),
    ),
  }, 201);
});
domainCommunityRouter.get(
  `${prefix}/posts/:id`,
  async (c) =>
    c.json({
      data: await read(c, async (s) =>
        await getPost(
          await resolvePostId(c.req.param("id")!),
          s.actorId ?? undefined,
          s.moderator,
          s,
        )),
    }),
);
domainCommunityRouter.patch(
  `${prefix}/posts/:id`,
  authMiddleware,
  async (c) =>
    c.json({
      data: await write(c, "community:create", async (s) =>
        await updatePost(
          await resolvePostId(c.req.param("id")!),
          s.actorId!,
          s.moderator,
          await input(c),
          s,
        )),
    }),
);
domainCommunityRouter.delete(
  `${prefix}/posts/:id`,
  authMiddleware,
  async (c) =>
    c.json({
      data: await write(c, "community:create", async (s) => {
        const id = await resolvePostId(c.req.param("id")!);
        const post = await getPost(id, s.actorId!, s.moderator, s);
        if (!s.moderator && post.post.author_id !== s.actorId) {
          throw new ForbiddenError("只能删除本人内容");
        }
        return await changePostStatus(id, s.actorId!, "deleted", "", s);
      }, true),
    }),
);
domainCommunityRouter.get(
  `${prefix}/posts/:id/comments`,
  async (c) =>
    c.json({
      data: await read(c, async (s) =>
        await listComments(
          await resolvePostId(c.req.param("id")!),
          s.actorId ?? undefined,
          s.moderator,
          s,
        )),
    }),
);
domainCommunityRouter.post(
  `${prefix}/posts/:id/comments`,
  authMiddleware,
  async (c) => {
    const body = await input<{ content: string; parent_id?: string }>(c);
    if (typeof body.content !== "string") {
      throw new BadRequestError(
        "评论正文必填",
      );
    }
    return c.json({
      data: await write(c, "community:comment", async (s) =>
        createComment(
          s.actorId!,
          await resolvePostId(c.req.param("id")!),
          body.content,
          body.parent_id,
          s.moderator,
          s,
        )),
    }, 201);
  },
);
domainCommunityRouter.patch(
  `${prefix}/comments/:id`,
  authMiddleware,
  async (c) => {
    const body = await input<{ content: string }>(c);
    if (typeof body.content !== "string") {
      throw new BadRequestError(
        "评论正文必填",
      );
    }
    return c.json({
      data: await write(c, "community:comment", (s) =>
        updateComment(
          c.req.param("id")!,
          s.actorId!,
          s.moderator,
          body.content,
          s,
        )),
    });
  },
);
domainCommunityRouter.delete(
  `${prefix}/comments/:id`,
  authMiddleware,
  async (c) =>
    c.json({
      data: await write(c, "community:comment", (s) =>
        deleteComment(c.req.param("id")!, s.actorId!, s.moderator, s), true),
    }),
);
domainCommunityRouter.post(
  `${prefix}/posts/:id/like`,
  authMiddleware,
  async (c) =>
    c.json({
      data: {
        liked: await write(
          c,
          "community:read",
          async (s) =>
            togglePostLike(
              s.actorId!,
              await resolvePostId(c.req.param("id")!),
              s,
            ),
        ),
      },
    }),
);
domainCommunityRouter.post(
  `${prefix}/posts/:id/bookmark`,
  authMiddleware,
  async (c) =>
    c.json({
      data: {
        bookmarked: await write(
          c,
          "community:read",
          async (s) =>
            toggleBookmark(
              s.actorId!,
              await resolvePostId(c.req.param("id")!),
              s,
            ),
        ),
      },
    }),
);
domainCommunityRouter.post(
  `${prefix}/comments/:id/like`,
  authMiddleware,
  async (c) =>
    c.json({
      data: {
        liked: await write(
          c,
          "community:read",
          (s) => toggleCommentLike(s.actorId!, c.req.param("id")!, s),
        ),
      },
    }),
);
domainCommunityRouter.get(
  `${prefix}/bookmarks`,
  authMiddleware,
  async (c) =>
    c.json(
      await read(c, (s) =>
        listBookmarks(
          s.actorId!,
          c.req.query("cursor"),
          parseQueryLimit(c.req.query("limit"), { default: 20 }),
          s,
        )),
    ),
);
domainCommunityRouter.get(
  `${prefix}/feed`,
  async (c) =>
    c.json(
      await read(c, (s) =>
        listFeed(
          c.req.query("view") === "following" ? "following" : "latest",
          s.actorId ?? undefined,
          c.req.query("cursor"),
          parseQueryLimit(c.req.query("limit"), { default: 20 }),
          s,
        )),
    ),
);
domainCommunityRouter.get(
  `${prefix}/solutions/eligibility`,
  authMiddleware,
  async (c) =>
    c.json({
      data: await read(c, async (s) => {
        const problem = await resolveCommunityProblem(
          c.req.query("problem_id") ?? "",
          s,
        );
        return {
          accepted: await hasAcceptedSolution(
            s.actorId!,
            problem.problem.id,
            s,
          ),
        };
      }),
    }),
);
domainCommunityRouter.patch(
  `${prefix}/posts/:id/official`,
  authMiddleware,
  async (c) => {
    const body = await input<{ value: boolean }>(c);
    if (typeof body.value !== "boolean") {
      throw new BadRequestError(
        "官方标记须为布尔值",
      );
    }
    await write(c, "community:create", async (s) =>
      setPostOfficial(
        await resolvePostId(c.req.param("id")!),
        s.actorId!,
        s.moderator,
        body.value,
        s,
      ));
    return c.json({ message: "已更新官方题解标记" });
  },
);
domainCommunityRouter.get(
  `${prefix}/notifications`,
  authMiddleware,
  async (c) =>
    c.json({
      data: await read(c, (s) =>
        listNotifications(
          s.actorId!,
          parseQueryLimit(c.req.query("limit"), { default: 30 }),
          s,
        )),
    }),
);
domainCommunityRouter.get(
  `${prefix}/notifications/unread-count`,
  authMiddleware,
  async (c) =>
    c.json({
      data: {
        count: await read(c, (s) => getNotificationUnreadCount(s.actorId!, s)),
      },
    }),
);
domainCommunityRouter.get(
  `${prefix}/notifications/:id`,
  authMiddleware,
  async (c) =>
    c.json({
      data: await read(c, (s) =>
        getNotification(s.actorId!, c.req.param("id")!, s)),
    }),
);
domainCommunityRouter.post(
  `${prefix}/notifications/read`,
  authMiddleware,
  async (c) => {
    await write(
      c,
      "community:read",
      (s) => markNotificationsRead(s.actorId!, s),
    );
    return c.json({ message: "已标记已读" });
  },
);
domainCommunityRouter.post(
  `${prefix}/notifications/:id/read`,
  authMiddleware,
  async (c) => {
    await write(
      c,
      "community:read",
      (s) => markNotificationRead(s.actorId!, c.req.param("id")!, s),
    );
    return c.json({ message: "已标记已读" });
  },
);
domainCommunityRouter.route("/", domainCommunityGovernanceRouter);
