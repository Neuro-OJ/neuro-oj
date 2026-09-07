import { Hono } from "hono";
import { optionalAuthMiddleware } from "../../identity/index.ts";
import { searchRateLimit } from "../middleware/search-rate-limit.ts";
import { searchFlat, searchGrouped } from "../services/search.ts";
import { getCommunityConfig } from "../../community/index.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
import { checkPermission } from "../../identity/index.ts";
import {
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "../../../shared/base/errors.ts";

type Env = {
  Variables: {
    userId?: string;
    userRole?: string;
    isAdmin?: boolean;
  };
};

const router = new Hono<Env>();

const ALL_TYPES = [
  "problem",
  "user",
  "community_post",
  "community_comment",
  "contest",
  "submission",
  "message",
  "announcement",
];

const COMMUNITY_TYPES = ["community_post", "community_comment"];

router.get(
  "/",
  optionalAuthMiddleware,
  searchRateLimit("anon"),
  async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const typesParam = c.req.query("types");
    let typeParam = c.req.query("type");
    const perTypeRaw = c.req.query("per_type");
    const perType = Math.min(
      Math.max(parseInt(perTypeRaw ?? "5", 10) || 5, 1),
      20,
    );
    const isAdmin = await checkPermission(c, "admin:full_access");
    const config = getCommunityConfig();
    const communityEnabled = config.enabled &&
      (config.solutions_enabled || config.discussions_enabled);
    const ctx = {
      userId: c.var.userId,
      isAdmin,
      guestReadEnabled: config.guest_read_enabled,
      communityEnabled,
    };

    if (q.length < 2) {
      throw new ValidationError("搜索关键词至少需要 2 个字符");
    }
    if (q.length > 100) {
      throw new ValidationError("搜索关键词最多 100 个字符");
    }

    if (typesParam) {
      const types = typesParam.split(",").map((s) => s.trim()).filter(Boolean);
      for (const t of types) {
        if (!ALL_TYPES.includes(t)) {
          throw new ValidationError(`types 包含非法类型: ${t}`);
        }
      }
      const filteredTypes = communityEnabled
        ? types
        : types.filter((t) => !COMMUNITY_TYPES.includes(t));
      const result = await searchGrouped({
        q,
        types: filteredTypes,
        perType,
        ctx,
      });
      c.header("X-Search-Took-Ms", String(result.took_ms));
      return c.json({
        data: {
          query: q,
          mode: "grouped",
          groups: result.groups,
          took_ms: result.took_ms,
        },
      });
    }

    if (
      typeParam && !ALL_TYPES.includes(typeParam) &&
      typeParam !== "community"
    ) {
      throw new ValidationError("type 参数非法");
    }
    if (
      typeParam === "community" ||
      typeParam === "community_post" ||
      typeParam === "community_comment"
    ) {
      if (!communityEnabled) {
        throw new ForbiddenError("该社区功能已关闭", "FEATURE_DISABLED");
      }
      if (!config.guest_read_enabled && !c.var.userId) {
        throw new UnauthorizedError("登录后可搜索社区内容");
      }
      // 兼容旧版 flat type=community：新索引将社区帖子与评论分开，
      // 旧接口语义仍保持“搜索社区帖子”。
      if (typeParam === "community") {
        typeParam = "community_post";
      }
    }
    if (typeParam === "user" && !isAdmin) {
      if (!c.var.userId) throw new UnauthorizedError("请先登录");
      throw new ForbiddenError("仅管理员可搜索用户");
    }

    const { page, perPage } = parsePagination(c, {
      defaultPerPage: 20,
      maxPerPage: 50,
    });
    const result = await searchFlat({
      q,
      type: typeParam || undefined,
      page,
      perPage,
      ctx,
    });
    c.header("X-Search-Took-Ms", String(result.took_ms));
    return c.json({
      data: {
        query: q,
        mode: "flat",
        items: result.items,
        has_more: result.has_more,
        page: result.page,
        per_page: result.per_page,
        took_ms: result.took_ms,
      },
    });
  },
);

export default router;
