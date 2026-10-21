import { type Context, Hono } from "hono";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { ensureDefaultWorkspace } from "../../../access/contracts/cross-module/workspace_services_domains.ts";
import { getInstanceResourcePolicy } from "../../../platform/contracts/resource-policy.ts";
import { loadWorkspace } from "../../../access/contracts/cross-module/workspace_services_access.ts";
import { checkPermission } from "../../../access/contracts/cross-module/identity_services_security_permissions.ts";
import { optionalAuthMiddleware } from "../../../access/identity/middleware/auth.ts";
import { searchRateLimit } from "../middleware/search-rate-limit.ts";
import { searchFlat, searchGrouped } from "../services/search.ts";
import { getCommunityConfig } from "../../../communication/contracts/cross-module/community_services_community_community-config.ts";
import { parsePagination } from "../../../../shared/http/pagination.ts";
import {
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "../../../../shared/base/errors.ts";

type Env = {
  Variables: {
    userId?: string;
    userRole?: string;
    isAdmin?: boolean;
  };
};

const router = new Hono<Env>();
/** 显式工作空间搜索；账号私信仍使用统一账号入口。 */
export const domainSearchRouter = new Hono<Env>();

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

const handler = async (c: Context<Env>) => {
  const q = (c.req.query("q") ?? "").trim();
  const typesParam = c.req.query("types");
  let typeParam = c.req.query("type");
  const perTypeRaw = c.req.query("per_type");
  const perType = Math.min(
    Math.max(parseInt(perTypeRaw ?? "5", 10) || 5, 1),
    20,
  );
  const slug = c.req.param("slug");
  const requestedTypes =
    typesParam?.split(",").map((type) => type.trim()).filter(Boolean) ??
      (typeParam ? [typeParam] : []);
  const accountOnly = !slug && requestedTypes.length > 0 &&
    requestedTypes.every((type) =>
      ["message", "user", "announcement"].includes(type)
    );
  if (!slug && !accountOnly) await ensureDefaultWorkspace();
  const access = accountOnly
    ? null
    : await loadWorkspace(slug ?? "main", c.var.userId ?? null);
  const isAdmin = access?.platformAdmin ??
    await checkPermission(c, "admin:full_access");
  const permissions = access?.context.domainPermissions ?? new Set<string>();
  const config = getCommunityConfig();
  const instancePolicy = await getInstanceResourcePolicy();
  const communityEnabled = instancePolicy.modules.community &&
    access?.domain.configuration.features.community === true &&
    config.enabled &&
    (config.solutions_enabled || config.discussions_enabled);
  const ctx = {
    userId: c.var.userId,
    isAdmin,
    guestReadEnabled: config.guest_read_enabled,
    communityEnabled,
    domainId: access?.domain.id ?? DEFAULT_DOMAIN_ID,
    member: !!access?.membership || isAdmin,
    communityModerator: isAdmin || permissions.has("community:moderate"),
    problemWriteAny: permissions.has("problem:write_any"),
    problemWriteOwn: permissions.has("problem:write_own"),
    contestManageAny: permissions.has("contest:manage"),
    contestManageOwn: permissions.has("contest:manage_own"),
    submissionReadAll: permissions.has("submission:read_all"),
    accountEntities: !slug,
  };
  c.header("Cache-Control", "no-store");

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
};
router.get("/", optionalAuthMiddleware, searchRateLimit("auto"), handler);
domainSearchRouter.get(
  "/domains/:slug/search",
  optionalAuthMiddleware,
  searchRateLimit("auto"),
  handler,
);

export default router;
