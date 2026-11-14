/**
 * 知识图谱只读 HTTP API（挂在 `/api/v1`）。
 *
 * - `GET /knowledge/graph`：整图（激活包 + active 领域/节点/前置）；
 * - `GET /knowledge/nodes/:id`：单点详情（requires / dependents）。
 * - `GET /knowledge/problems/:problemId`：题目归类（可选鉴权）；
 * - `PUT /knowledge/problems/:problemId`：人工挂载（题目编辑权限）。
 * - `GET|POST /admin/knowledge/reviews...`：审核队列（实例管理员）。
 * - `GET /admin/knowledge/tagging/usage|estimate` 与
 *   `POST /admin/knowledge/tagging/backfill`：AI 打标用量/预估/回填（实例管理员）。
 *
 * `/admin/knowledge/*` 不在 admin 聚合路由下（功能路由挂在 admin 之前），因此
 * 必须显式挂 `authMiddleware` + 实例管理员检查，参照
 * `features/legal/`。
 *
 * 公开读：与其他列表接口一致使用可选鉴权（实例访问政策中间件在
 * `/api/v1/*` 全局生效）。`knowledge_enabled = false` 时两个接口都返回 404
 * `KNOWLEDGE_DISABLED`；开关每次请求经 `getSetting()` 读取，不走本模块缓存。
 */
import { Hono } from "hono";
import { userActorFromAuthenticatedId } from "../../modules/access/contracts/actor.ts";
import {
  authMiddleware,
  optionalAuthMiddleware,
} from "../../modules/access/index.ts";
import { isUserAdmin } from "../../modules/access/contracts/cross-module/identity_services_security_permissions.ts";
import {
  enforceRateLimit,
  getClientIp,
  getSetting,
} from "../../modules/platform/index.ts";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
} from "../../shared/base/errors.ts";
import type { AuthEnv } from "../../shared/http/hono-env.ts";
import { parsePagination } from "../../shared/http/pagination.ts";
import { parseJsonBody } from "../../shared/http/request.ts";
import { readKnowledgeGraph, readKnowledgeNode } from "./graph.ts";
import {
  backfillKnowledgeTags,
  estimateBackfill,
  readTagUsage,
  requireTagAdmin,
} from "./tagging.ts";
import {
  listPendingMappings,
  type MappingDecision,
  parseProblemId,
  readProblemKnowledge,
  reviewMapping,
  setProblemKnowledgeManually,
} from "./mappings.ts";

export const knowledgeRouter = new Hono<AuthEnv>();

/** 关闭提示：与 NotFoundError 同状态码，但使用专用错误码便于前端区分。 */
class KnowledgeDisabledError extends AppError {
  constructor() {
    super("知识图谱功能已关闭", 404, "KNOWLEDGE_DISABLED");
    this.name = "KnowledgeDisabledError";
  }
}

function assertEnabled(): void {
  if (getSetting("knowledge_enabled")?.value !== true) {
    throw new KnowledgeDisabledError();
  }
}

knowledgeRouter.get("/knowledge/graph", optionalAuthMiddleware, async (c) => {
  assertEnabled();
  return c.json({ data: await readKnowledgeGraph() });
});

knowledgeRouter.get(
  "/knowledge/nodes/:id",
  optionalAuthMiddleware,
  async (c) => {
    assertEnabled();
    return c.json({ data: await readKnowledgeNode(c.req.param("id")!) });
  },
);

/** 读接口的查看者：未登录时为 null。 */
/**
 * 实例管理员检查（`users.role = 'admin'`，与 admin 聚合路由的 `adminMiddleware`
 * 同一口径）。功能路由不经 admin 聚合中间件，这里显式断言。
 */
async function requireInstanceAdmin(userId: string): Promise<void> {
  if (!(await isUserAdmin(userId))) {
    throw new ForbiddenError("需要管理员权限");
  }
}

function viewerOf(c: { get: (key: "userId") => string | undefined }) {
  return { userId: c.get("userId") ?? null };
}

knowledgeRouter.get(
  "/knowledge/problems/:problemId",
  optionalAuthMiddleware,
  async (c) => {
    assertEnabled();
    const problemId = parseProblemId(c.req.param("problemId"));
    const view = await readProblemKnowledge(problemId, viewerOf(c));
    // 保护期内的题目对非编辑者与「不存在」不可区分。
    if (!view) throw new NotFoundError("题目不存在");
    return c.json({ data: view });
  },
);

knowledgeRouter.put(
  "/knowledge/problems/:problemId",
  authMiddleware,
  async (c) => {
    assertEnabled();
    const problemId = parseProblemId(c.req.param("problemId"));
    // 写路由限流：人工挂载是低频管理动作，按用户限流防止脚本刷写。
    await enforceRateLimit(
      `knowledge-mapping:user:${c.get("userId") as string}`,
      { windowSec: 60, max: 30 },
    );
    const body = await parseJsonBody<
      { primary?: unknown; secondary?: unknown }
    >(
      c,
    );
    const view = await setProblemKnowledgeManually(
      userActorFromAuthenticatedId(c.get("userId")!),
      problemId,
      body,
      { ipAddress: getClientIp(c) },
    );
    return c.json({ data: view });
  },
);

/** 审核队列（实例管理员）。 */
knowledgeRouter.get(
  "/admin/knowledge/reviews",
  authMiddleware,
  async (c) => {
    assertEnabled();
    await requireInstanceAdmin(c.get("userId")!);
    const { page, perPage } = parsePagination(c, { defaultPerPage: 20 });
    return c.json({
      data: await listPendingMappings({ page, limit: perPage }),
    });
  },
);

/** 审核决定：`{ decision: "accept" | "reject" }` 或 `{ primary, secondary }`。 */
knowledgeRouter.post(
  "/admin/knowledge/reviews/:problemId",
  authMiddleware,
  async (c) => {
    assertEnabled();
    await requireInstanceAdmin(c.get("userId")!);
    await enforceRateLimit(
      `knowledge-review:user:${c.get("userId") as string}`,
      { windowSec: 60, max: 60 },
    );
    const problemId = parseProblemId(c.req.param("problemId"));
    const body = await parseJsonBody<Record<string, unknown>>(c);
    const decision: MappingDecision = body.decision === "accept" ||
        body.decision === "reject"
      ? body.decision as "accept" | "reject"
      : (body as unknown as { primary: string; secondary: string[] });
    const view = await reviewMapping(
      userActorFromAuthenticatedId(c.get("userId")!),
      problemId,
      decision,
      { ipAddress: getClientIp(c) },
    );
    return c.json({ data: view });
  },
);

// ── AI 打标管理（实例管理员）────────────────────────────
// 写路由限流按用户；读路由为低频只读（用量/预估各有一次网关往返），不额外限流。

/** 本月用量：token、请求数、预算与剩余、开关与别名配置状态。 */
knowledgeRouter.get(
  "/admin/knowledge/tagging/usage",
  authMiddleware,
  async (c) => {
    assertEnabled();
    await requireTagAdmin(c.get("userId")!);
    return c.json({ data: await readTagUsage() });
  },
);

/** 回填预估：待打标题目数、token 与费用估算。 */
knowledgeRouter.get(
  "/admin/knowledge/tagging/estimate",
  authMiddleware,
  async (c) => {
    assertEnabled();
    await requireTagAdmin(c.get("userId")!);
    return c.json({ data: await estimateBackfill() });
  },
);

/**
 * 回填投递：body `{ confirm: true, expected_count }`；实际题目数与预估偏差
 * 超过 10% → 409 要求重新预估。按题目去重投递，写审计。
 */
knowledgeRouter.post(
  "/admin/knowledge/tagging/backfill",
  authMiddleware,
  async (c) => {
    assertEnabled();
    const userId = c.get("userId")!;
    await requireTagAdmin(userId);
    await enforceRateLimit(`knowledge-backfill:user:${userId}`, {
      windowSec: 60,
      max: 3,
    });
    const body = await parseJsonBody<Record<string, unknown>>(c);
    return c.json({
      data: await backfillKnowledgeTags(
        userActorFromAuthenticatedId(userId),
        body,
        { ipAddress: getClientIp(c) },
      ),
    });
  },
);
