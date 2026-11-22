/**
 * 知识图谱只读 HTTP API（挂在 `/api/v1`）。
 *
 * - `GET /knowledge/graph`：整图（激活包 + active 领域/节点/前置）；
 * - `GET /knowledge/nodes/:id`：单点详情（requires / dependents / 讲解 markdown）；
 * - `GET /knowledge/nodes/:id/ladder?domain=<slug>`：节点题目阶梯 + 下一题；
 * - `GET /knowledge/problems/:problemId`：题目归类 + 难度（可选鉴权）；
 * - `GET /knowledge/problems/:problemId/next`：题目页下一题；
 * - `PUT /knowledge/problems/:problemId`：人工挂载与及格线覆盖（题目编辑权限）。
 * - `GET|POST /admin/knowledge/reviews...`：审核队列（实例管理员）。
 * - `GET /admin/knowledge/tagging/usage|estimate` 与
 *   `POST /admin/knowledge/tagging/backfill`：AI 打标用量/预估/回填（实例管理员）。
 * - `GET /knowledge/me/mastery|recommendations`：我的掌握度与推荐（登录用户）。
 * - `GET /knowledge/nodes/:id/diagnosis`：根因诊断（未登录返回空）。
 * - `GET /admin/knowledge/coverage`：覆盖度面板（实例管理员；`?domain=` 时域
 *   管理员可见本域）。
 * - `GET /domains/:slug/classrooms/:id/knowledge-mastery|knowledge-pick`：
 *   教练视角班级掌握矩阵与按知识点挑题（班级教练 / 域管理员 / 平台管理员）。
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
    loadWorkspace,
    optionalAuthMiddleware,
} from "../../modules/access/index.ts";
import { isUserAdmin } from "../../modules/access/contracts/cross-module/identity_services_security_permissions.ts";
import {
    assertClassroomCoach,
    loadClassroom,
} from "../../modules/education/index.ts";
import {
    enforceRateLimit,
    getClientIp,
    getSetting,
} from "../../modules/platform/index.ts";
import {
    AppError,
    BadRequestError,
    ForbiddenError,
    NotFoundError,
    UnauthorizedError,
} from "../../shared/base/errors.ts";
import type { AuthEnv } from "../../shared/http/hono-env.ts";
import { parsePagination } from "../../shared/http/pagination.ts";
import { parseJsonBody } from "../../shared/http/request.ts";
import { readKnowledgeGraph, readKnowledgeNode } from "./graph.ts";
import {
    loadNodeProblemCounts,
    readNextForProblem,
    readNodeLadder,
    readProblemDifficulty,
    resolveAccessibleDomain,
} from "./difficulty.ts";
import {
    type ClassMasteryView,
    PICK_DEFAULT_COUNT,
    PICK_MAX_COUNT,
    readClassMastery,
    readKnowledgePick,
} from "./coach.ts";
import { setPassRatioOverride } from "./pass-ratio.ts";
import {
    type CoverageView,
    diagnoseNode,
    readCoverage,
    readMyMastery,
    readMyRecommendations,
    RECOMMENDATIONS_MAX_LIMIT,
} from "./mastery.ts";
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

/**
 * 整图（`?domain=<slug>` 可选）：给定时每个节点附 `problem_count`
 * （该域当前用户可访问的已发布题目数，供「只显示有题的知识点」）。
 */
knowledgeRouter.get("/knowledge/graph", optionalAuthMiddleware, async (c) => {
    assertEnabled();
    const graph = await readKnowledgeGraph();
    const slug = c.req.query("domain");
    if (!slug) return c.json({ data: graph });
    const userId = c.get("userId") ?? null;
    const viewer = userId ? userActorFromAuthenticatedId(userId) : null;
    const domain = await resolveAccessibleDomain(slug, viewer);
    if (!domain) throw new NotFoundError("工作空间不存在");
    const counts = await loadNodeProblemCounts(
        graph.nodes.map((node) => node.id),
        domain.id,
        viewer,
        { is_admin: await isViewerAdmin(userId) },
    );
    return c.json({
        data: {
            ...graph,
            nodes: graph.nodes.map((node) => ({
                ...node,
                problem_count: counts.get(node.id) ?? 0,
            })),
        },
    });
});

knowledgeRouter.get(
    "/knowledge/nodes/:id",
    optionalAuthMiddleware,
    async (c) => {
        assertEnabled();
        return c.json({ data: await readKnowledgeNode(c.req.param("id")!) });
    },
);

/**
 * 节点题目阶梯（`?domain=<slug>`）：该节点为主知识点的已发布、可访问题目，
 * 按校准难度升序；`next` 为下一题推荐。未登录时 `passed` 为 null、`next`
 * 取第一题；域不可访问 → 404。
 */
knowledgeRouter.get(
    "/knowledge/nodes/:id/ladder",
    optionalAuthMiddleware,
    async (c) => {
        assertEnabled();
        const slug = c.req.query("domain");
        if (!slug) throw new BadRequestError("缺少 domain 参数");
        const userId = c.get("userId") ?? null;
        const viewer = userId ? userActorFromAuthenticatedId(userId) : null;
        const ladder = await readNodeLadder(
            c.req.param("id")!,
            slug,
            viewer,
            { is_admin: await isViewerAdmin(userId) },
        );
        if (!ladder) throw new NotFoundError("知识点或工作空间不存在");
        return c.json({ data: ladder });
    },
);

/** 题目页「下一题」：该题主知识点阶梯中难度更高、用户未达标的第一题。 */
knowledgeRouter.get(
    "/knowledge/problems/:problemId/next",
    optionalAuthMiddleware,
    async (c) => {
        assertEnabled();
        const problemId = parseProblemId(c.req.param("problemId"));
        const userId = c.get("userId") ?? null;
        const viewer = userId ? userActorFromAuthenticatedId(userId) : null;
        const next = await readNextForProblem(problemId, viewer);
        return c.json({ data: next });
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

/** 查看者是否实例管理员（阶梯可达性口径用；未登录为 false）。 */
async function isViewerAdmin(userId: string | null): Promise<boolean> {
    if (!userId) return false;
    try {
        return await isUserAdmin(userId);
    } catch {
        return false;
    }
}

knowledgeRouter.get(
    "/knowledge/problems/:problemId",
    optionalAuthMiddleware,
    async (c) => {
        assertEnabled();
        const problemId = parseProblemId(c.req.param("problemId"));
        // 实例管理员可见保护期题目的挂载（与题目管理口径一致）。
        const isAdminViewer = await isViewerAdmin(c.get("userId") ?? null);
        const view = await readProblemKnowledge(problemId, {
            ...viewerOf(c),
            is_admin: isAdminViewer,
        });
        // 保护期内的题目对非编辑者与「不存在」不可区分。
        if (!view) throw new NotFoundError("题目不存在");
        return c.json({
            data: {
                ...view,
                difficulty: await readProblemDifficulty(problemId),
            },
        });
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
            {
                primary?: unknown;
                secondary?: unknown;
                pass_ratio_override?: unknown;
            }
        >(
            c,
        );
        const actor = userActorFromAuthenticatedId(c.get("userId")!);
        // 出题人按题覆盖及格线：与挂载分开校验/落库，缺省不改动。
        if ("pass_ratio_override" in body) {
            await setPassRatioOverride(
                actor,
                problemId,
                body.pass_ratio_override,
                {
                    ipAddress: getClientIp(c),
                },
            );
        }
        const view = await setProblemKnowledgeManually(
            actor,
            problemId,
            body,
            { ipAddress: getClientIp(c) },
        );
        return c.json({
            data: {
                ...view,
                difficulty: await readProblemDifficulty(problemId),
            },
        });
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

// ── 掌握度、推荐与根因诊断（P3）──────────────────────────
// 只读接口：与其他只读列表一致使用可选鉴权；`/knowledge/me/*` 要求登录。

/** 读取 `?domain=<slug>` 并解析为当前用户可访问的域；缺省返回 null。 */
async function resolveDomainQuery(
    c: {
        req: { query: (key: string) => string | undefined };
        get: (k: "userId") => string | undefined;
    },
): Promise<{ id: string; slug: string } | null> {
    const slug = c.req.query("domain");
    if (!slug) return null;
    const userId = c.get("userId") ?? null;
    const viewer = userId ? userActorFromAuthenticatedId(userId) : null;
    const domain = await resolveAccessibleDomain(slug, viewer);
    if (!domain) throw new NotFoundError("工作空间不存在");
    return domain;
}

/** 我的掌握度（按域可选）：每节点状态与题量 + 领域汇总。 */
knowledgeRouter.get(
    "/knowledge/me/mastery",
    authMiddleware,
    async (c) => {
        assertEnabled();
        const userId = c.get("userId")!;
        const domain = await resolveDomainQuery(c);
        return c.json({ data: await readMyMastery(userId, domain) });
    },
);

/** 我的推荐（前沿节点 + 根因提示）：`?domain=<slug>&limit=5`。 */
knowledgeRouter.get(
    "/knowledge/me/recommendations",
    authMiddleware,
    async (c) => {
        assertEnabled();
        const userId = c.get("userId")!;
        const domain = await resolveDomainQuery(c);
        if (!domain) throw new BadRequestError("缺少 domain 参数");
        const rawLimit = Number(c.req.query("limit") ?? "5");
        const limit = Number.isInteger(rawLimit) && rawLimit > 0
            ? Math.min(RECOMMENDATIONS_MAX_LIMIT, rawLimit)
            : 5;
        return c.json({
            data: await readMyRecommendations(userId, domain, limit),
        });
    },
);

/**
 * 根因诊断：给定节点的未掌握前置链（最多 5 个）。
 *
 * 未登录返回空链（不暴露个人掌握情况）；节点不存在或已废弃 → 404。
 */
knowledgeRouter.get(
    "/knowledge/nodes/:id/diagnosis",
    optionalAuthMiddleware,
    async (c) => {
        assertEnabled();
        const nodeId = c.req.param("id")!;
        await resolveDomainQuery(c);
        const userId = c.get("userId") ?? null;
        if (!userId) {
            return c.json({
                data: {
                    node_id: nodeId,
                    state: "none",
                    missing_prerequisites: [],
                    chain: [],
                },
            });
        }
        const view = await diagnoseNode(userId, nodeId);
        if (!view) throw new NotFoundError("知识点不存在");
        return c.json({ data: view });
    },
);

/**
 * 覆盖度面板（聚合 SQL）。
 *
 * 权限：实例管理员可看全实例或任一域；域管理员（`problem:write_any`）只能看
 * 本域。`?domain=` 缺省时仅实例管理员可见全实例汇总。
 */
knowledgeRouter.get(
    "/admin/knowledge/coverage",
    authMiddleware,
    async (c) => {
        assertEnabled();
        const userId = c.get("userId")!;
        const slug = c.req.query("domain");
        let view: CoverageView;
        if (slug) {
            // 域管理员走 loadWorkspace 的能力判断（不是该域成员 → 访问异常即 403/404）。
            const workspace = await loadWorkspace(
                slug,
                userActorFromAuthenticatedId(userId),
            );
            if (
                !workspace.platformAdmin &&
                !workspace.context.domainPermissions.has("problem:write_any")
            ) {
                throw new ForbiddenError("需要实例管理员或本域管理员权限");
            }
            view = await readCoverage({
                id: workspace.domain.id,
                slug,
            });
        } else {
            await requireInstanceAdmin(userId);
            view = await readCoverage(null);
        }
        return c.json({ data: view });
    },
);

// ── 教练视角（P4）：班级掌握矩阵与按知识点挑题 ─────────────
// 只读接口；权限为班级教练（loadClassroom + assertClassroomCoach），学生 → 403
// CLASSROOM_PERMISSION_DENIED，非成员 404，未登录 401。班级按
// 「历史学生可见」读取（与 `GET /classrooms/:id` 同口径），因此已离班学生也走
// 403 而不是被伪装成 404。

/** 解析班级访问：未登录 401；不可见 404；无教练身份 403（教学域判定）。 */
async function loadCoachClassroom(c: {
    req: { param: (key: string) => string | undefined };
    get: (k: "userId") => string | undefined;
}): Promise<{
    slug: string;
    classroomId: string;
    domain: { id: string; slug: string };
}> {
    const userId = c.get("userId");
    if (!userId) throw new UnauthorizedError("未提供认证令牌");
    const slug = c.req.param("slug")!;
    const classroomId = c.req.param("id")!;
    const access = await loadClassroom(slug, classroomId, userId, {
        historicalStudent: true,
    });
    assertClassroomCoach(access);
    return {
        slug: access.domain.slug,
        classroomId: access.classroom.id,
        domain: { id: access.domain.id, slug: access.domain.slug },
    };
}

/** 班级掌握矩阵（学生 × 知识点；cells 稀疏，counts 三项之和 = 学生数）。 */
knowledgeRouter.get(
    "/domains/:slug/classrooms/:id/knowledge-mastery",
    optionalAuthMiddleware,
    async (c) => {
        assertEnabled();
        const target = await loadCoachClassroom(c);
        const view: ClassMasteryView = await readClassMastery(
            target.classroomId,
            target.domain,
        );
        return c.json({ data: view });
    },
);

/** 按知识点挑题：`?node=<id>&count=1-20`（默认 5），均匀抽样，不建作业。 */
knowledgeRouter.get(
    "/domains/:slug/classrooms/:id/knowledge-pick",
    optionalAuthMiddleware,
    async (c) => {
        assertEnabled();
        const nodeId = c.req.query("node");
        if (!nodeId) throw new BadRequestError("缺少 node 参数");
        const rawCount = c.req.query("count");
        let count = PICK_DEFAULT_COUNT;
        if (rawCount !== undefined) {
            const parsed = Number(rawCount);
            if (
                !Number.isInteger(parsed) || parsed < 1 ||
                parsed > PICK_MAX_COUNT
            ) {
                throw new BadRequestError(
                    `count 必须在 1–${PICK_MAX_COUNT} 之间`,
                );
            }
            count = parsed;
        }
        const target = await loadCoachClassroom(c);
        const view = await readKnowledgePick({
            nodeId,
            count,
            domain: target.domain,
        });
        if (!view) throw new NotFoundError("知识点不存在");
        return c.json({ data: view });
    },
);
