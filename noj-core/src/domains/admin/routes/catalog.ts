/**
 * Admin catalog 子域路由。
 *
 * 挂载前缀：/api/v1/admin/catalog（由 domains/admin/index.ts 以 /catalog 挂载）。
 * 合并原 catalog 域两个管理路由文件：
 * - admin-problems（题目管理与评定）
 * - admin-trainings（题单管理）
 *
 * 审计分层：
 * - problems review 与 trainings update/delete 原先未在 service 层审计，
 *   因此由路由层 withAudit 作为唯一审计源。
 * - 权限在具体 handler 内声明：通用题目管理仍要求 admin:full_access；
 *   problems/review 使用 problem:create_p；trainings 使用 training:* 细粒度权限。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { eq, inArray, sql } from "drizzle-orm";
import type { AuthEnv } from "../../identity/index.ts";
import {
  assertPermission,
  authMiddleware,
  checkPermission,
} from "../../identity/index.ts";
import { withActorContext } from "../../system/index.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import { getDb } from "../../../shared/db/connection.ts";
import { problems } from "../../../shared/db/schema.ts";
import { listAllProblems } from "../../catalog/services/problems/problems.ts";
import { resolveProblem } from "../../catalog/services/problem-resolve.ts";
import { inspectEvaluationPackage } from "../../catalog/services/bundle-parser.ts";
import {
  getProblemTemplate,
  getSupportPackageBytes,
} from "../../catalog/services/support-package.ts";
import { validateJudgeImageWithKind } from "../../system/index.ts";
import {
  deleteTraining,
  getTraining,
  listAllTrainings,
  resolveTrainingId,
  updateTraining,
} from "../../catalog/services/trainings.ts";
import type { UpdateTrainingInput } from "../../catalog/types/trainings.ts";
import { withAudit } from "../services/admin-audit.ts";
import type { AuditMeta } from "../types/admin-audit.ts";
import { adminVersionMiddleware } from "../middleware/admin-version.ts";

/** 路由层审计用的临时请求体缓存（withAudit 在 handler 返回后才构建 detail）。 */
const auditBodies = new WeakMap<object, unknown>();

function setAuditBody(c: object, body: unknown): void {
  auditBodies.set(c, body);
}

function getAuditBody<T>(c: object): T | undefined {
  return auditBodies.get(c) as T | undefined;
}

/** 将 AuthEnv handler 适配为 withAudit 接受的 Context handler。 */
function auditRoute(
  meta: AuditMeta,
  handler: (c: Context<AuthEnv>) => Promise<Response>,
) {
  return withAudit(meta)(handler as (c: Context) => Promise<Response>);
}

const router = new Hono<AuthEnv>();

/**
 * 组级中间件：认证 + RequestContext 注入；具体权限在各 handler 内按需校验。
 * 应用于本路由组全部路径。
 */
router.use("*", authMiddleware, (c, next) => {
  return withActorContext(c, () => next());
});

/**
 * 发布前预检：结果绑定题目当前配置与支持包内容的 SHA-256 指纹。
 * GET /api/v1/admin/catalog/problems/:id/preflight
 */
router.get("/problems/:id/preflight", async (c) => {
  await assertPermission(c, "admin:full_access");
  const problem = await resolveProblem(c.req.param("id"));
  const checks: Array<
    { name: string; status: "pass" | "error" | "warning"; message: string }
  > = [];
  const add = (
    name: string,
    status: "pass" | "error" | "warning",
    message: string,
  ) => checks.push({ name, status, message });

  if (problem.is_objective) {
    add("runtime", "pass", "客观题无需双容器运行配置");
  } else if (!problem.runtime_config) {
    add("runtime", "error", "缺少 runtime_config");
  } else {
    for (
      const [kind, config] of [
        ["evaluator", problem.runtime_config.evaluator],
        ["solution", problem.runtime_config.solution],
      ] as const
    ) {
      try {
        await validateJudgeImageWithKind(config.image, kind);
        add(`image:${kind}`, "pass", `镜像 ${config.image} 已在白名单中`);
      } catch (error) {
        add(
          `image:${kind}`,
          "error",
          error instanceof Error ? error.message : "镜像校验失败",
        );
      }
    }
  }

  const template = problem.is_objective ? null : await getProblemTemplate({
    number: problem.number,
    title: problem.title,
  });
  add(
    "template",
    template ? "pass" : "warning",
    template ? "模板可读取" : "未找到模板，发布后编辑器没有初始代码",
  );
  const packageBytes = await getSupportPackageBytes(
    problem.id,
    c.var.userId,
    undefined,
    c,
  );
  add(
    "support_package",
    packageBytes ? "pass" : "error",
    packageBytes ? "支持包可读取" : "缺少支持包",
  );

  if (packageBytes && !problem.is_objective) {
    try {
      const inspection = inspectEvaluationPackage(packageBytes);
      add(
        "evaluator_entry",
        inspection.hasEvaluator ? "pass" : "error",
        inspection.hasEvaluator
          ? "根级 evaluate.py 存在"
          : "评测包缺少根级 evaluate.py",
      );
      add(
        "visible_cases",
        inspection.hasVisibleCases ? "pass" : "error",
        inspection.hasVisibleCases
          ? "可见测试数据存在"
          : "评测包缺少根级 visible.jsonl",
      );
      add(
        "hidden_cases",
        inspection.hasHiddenCases ? "pass" : "warning",
        inspection.hasHiddenCases
          ? "隐藏测试数据存在"
          : "未发现约定的 hidden.jsonl；请确认 evaluator 自己管理隐藏数据",
      );
      add(
        "reference_solution",
        inspection.referenceSolution ? "pass" : "warning",
        inspection.referenceSolution
          ? `发现标准解 \${inspection.referenceSolution}`
          : "未发现约定的标准解，尚未执行标准解运行验收",
      );
    } catch (error) {
      add(
        "package_structure",
        "error",
        error instanceof Error ? error.message : "评测包结构检查失败",
      );
    }
    add(
      "runtime_execution",
      "warning",
      "当前仅完成静态包检查；标准解执行、隐藏标记泄漏、超时和资源清理仍需隔离 Judge 验收",
    );
  }

  const packageDigest = packageBytes
    ? await crypto.subtle.digest("SHA-256", packageBytes.slice().buffer)
    : null;
  const packageFingerprint = packageDigest
    ? Array.from(new Uint8Array(packageDigest)).map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
    : null;
  const fingerprintInput = JSON.stringify({
    problem,
    template,
    package: packageFingerprint,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(fingerprintInput),
  );
  const fingerprint = Array.from(new Uint8Array(digest)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const errors = checks.filter((check) => check.status === "error");
  return c.json({
    data: {
      problem_id: problem.id,
      fingerprint,
      can_publish: errors.length === 0,
      checks,
    },
  });
});

/**
 * 管理员获取全量题目列表（含 U 型和 P 型）。
 * GET /api/v1/admin/catalog/problems
 */
router.get("/problems", async (c) => {
  await assertPermission(c, "admin:full_access");
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);

  if (Number.isNaN(page) || Number.isNaN(limit)) {
    throw new BadRequestError("分页参数 page 和 limit 必须为数字");
  }

  const result = await listAllProblems({
    page: Math.max(1, page),
    limit: Math.min(100, Math.max(1, limit)),
    difficulty: c.req.query("difficulty") || undefined,
    tag: c.req.query("tag") || undefined,
    keyword: c.req.query("keyword") || undefined,
  });

  return c.json({
    data: result.items,
    total: result.total,
    page: result.page,
    limit: result.limit,
  });
});

/**
 * 题目评定队列列表。
 * GET /api/v1/admin/catalog/problems/review?queue=public|p
 * - queue=public：待转公开（U 型 private）
 * - queue=p：待转 P（U 型 public）
 */
router.get("/problems/review", async (c) => {
  await assertPermission(c, "problem:create_p");
  const rawQueue = c.req.query("queue") || "public";
  const queue = rawQueue === "to_public"
    ? "public"
    : rawQueue === "to_p"
    ? "p"
    : rawQueue;
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);

  if (Number.isNaN(page) || Number.isNaN(limit)) {
    throw new BadRequestError("分页参数 page 和 limit 必须为数字");
  }

  const visibility = queue === "public"
    ? "private"
    : queue === "p"
    ? "public"
    : undefined;
  if (!visibility) {
    throw new BadRequestError("queue 必须为 public 或 p");
  }

  const result = await listAllProblems({
    page: Math.max(1, page),
    limit: Math.min(100, Math.max(1, limit)),
    type: "U",
    visibility,
  });

  return c.json({
    data: result.items,
    total: result.total,
    page: result.page,
    limit: result.limit,
  });
});

/**
 * 题目评定批量操作。
 * POST /api/v1/admin/catalog/problems/review
 * body: { problem_ids: string[], action: "to_public" | "to_p" }
 * - to_public：批量将 U 型题转为 public
 * - to_p：批量将 U 型题转为 P 型（需 problem:create_p，admin:full_access 通配）
 */
router.post(
  "/problems/review",
  auditRoute(
    {
      action: "problems.review",
      target: (c) => {
        const body = getAuditBody<{
          problem_ids?: string[];
          ids?: string[];
        }>(c);
        return {
          type: "problem",
          id: (body?.problem_ids ?? body?.ids ?? []).join(","),
        };
      },
      buildDetail: (c) => {
        const body = getAuditBody<{
          problem_ids?: string[];
          ids?: string[];
          action?: string;
        }>(c);
        return {
          action: "problems.review",
          problem_ids: body?.problem_ids ?? body?.ids ?? [],
          operation: body?.action ?? "",
        };
      },
    },
    async (c) => {
      await assertPermission(c, "problem:create_p");
      const body = await parseJsonBody<{
        problem_ids?: unknown;
        ids?: unknown;
        action?: unknown;
      }>(c);
      setAuditBody(c, body);

      const rawIds = body.problem_ids ?? body.ids;
      if (!Array.isArray(rawIds) || rawIds.length === 0) {
        throw new BadRequestError("problem_ids/ids 必须为非空数组");
      }
      const ids = [
        ...new Set(
          rawIds.filter((v): v is string => typeof v === "string")
            .map((v) => v.trim()).filter(Boolean),
        ),
      ];
      if (ids.length === 0) {
        throw new BadRequestError("problem_ids/ids 必须包含非空字符串");
      }

      const rawAction = body.action;
      const action = rawAction === "public"
        ? "to_public"
        : rawAction === "p"
        ? "to_p"
        : rawAction;
      if (action === "to_public") {
        const db = getDb();
        const existing = await db.select({ id: problems.id })
          .from(problems)
          .where(inArray(problems.id, ids));
        if (existing.length !== ids.length) {
          throw new NotFoundError("部分题目不存在");
        }
        const updatedAt = new Date().toISOString();
        const updated = await db.update(problems).set({
          visibility: "public",
          updated_at: updatedAt,
        }).where(inArray(problems.id, ids)).returning({ id: problems.id });
        return c.json({
          data: {
            action,
            updated: updated.length,
          },
        });
      }

      if (action === "to_p") {
        const db = getDb();
        const rows = await db.select({
          id: problems.id,
          title: problems.title,
          type: problems.type,
          number: problems.number,
          owner_id: problems.owner_id,
        }).from(problems).where(inArray(problems.id, ids));

        if (rows.length !== ids.length) {
          throw new NotFoundError("部分题目不存在");
        }
        const nonU = rows.find((row) => row.type !== "U");
        if (nonU) {
          throw new BadRequestError(`仅支持将 U 型题转为 P 型：${nonU.id}`);
        }

        const [maxRow] = await db.select({
          max: sql<number>`COALESCE(MAX(${problems.number}), 0)`,
        }).from(problems).where(eq(problems.type, "P"));
        let nextNumber = Number(maxRow?.max ?? 0) + 1;
        const updatedAt = new Date().toISOString();

        let updated = 0;
        await db.transaction(async (tx) => {
          for (const row of rows) {
            const result = await tx.update(problems).set({
              type: "P",
              visibility: "public",
              number: nextNumber++,
              updated_at: updatedAt,
            }).where(eq(problems.id, row.id)).returning({
              id: problems.id,
            });
            if (result.length > 0) updated++;
          }
        });

        return c.json({
          data: { action, updated },
        });
      }

      throw new BadRequestError("action 必须为 to_public 或 to_p");
    },
  ),
);

/**
 * 全部题单列表（含 private）。
 * GET /api/v1/admin/catalog/trainings?page=&per_page=
 * 需 training:read_any。
 */
router.get("/trainings", async (c) => {
  await assertPermission(c, "training:read_any");
  const { page, perPage } = parsePagination(c);
  const result = await listAllTrainings({ page, perPage });
  return c.json({
    data: result.data,
    total: result.total,
    page,
    per_page: perPage,
  });
});

/**
 * 更新任意题单（含设为 public / 置顶）。
 * PATCH /api/v1/admin/catalog/trainings/:id
 * 需 training:write_any；设为 public 需 training:publish，置顶需 training:pin。
 * body: { title?, description?, visibility?, is_pinned? }。
 */
router.patch(
  "/trainings/:id",
  adminVersionMiddleware(async (c) => {
    const id = await resolveTrainingId(c.req.param("id") as string);
    return (await getTraining(id)).updated_at;
  }),
  auditRoute(
    {
      action: "trainings.update",
      target: (c) => ({ type: "training", id: c.req.param("id")! }),
      buildDetail: (c) => {
        const body = getAuditBody<{
          title?: string;
          description?: string;
          visibility?: string;
          is_pinned?: boolean;
        }>(c);
        return {
          action: "trainings.update",
          id: c.req.param("id")!,
          title: body?.title,
          description: body?.description,
          visibility: body?.visibility,
          is_pinned: body?.is_pinned,
        };
      },
    },
    async (c) => {
      const id = await resolveTrainingId(c.req.param("id") as string);
      const body = await parseJsonBody<UpdateTrainingInput>(c);
      setAuditBody(c, body);
      assertObjectBody(body as unknown);
      const canPublish = await checkPermission(c, "training:publish");
      const canPin = await checkPermission(c, "training:pin");

      const editsTitleOrDescription = body.title !== undefined ||
        body.description !== undefined;
      const editsNonPublicVisibility = body.visibility !== undefined &&
        body.visibility !== "public";
      if (editsTitleOrDescription || editsNonPublicVisibility) {
        await assertPermission(c, "training:write_any");
      }
      if (body.visibility === "public") {
        await assertPermission(c, "training:publish");
      }
      if (body.is_pinned !== undefined) {
        await assertPermission(c, "training:pin");
      }

      const updated = await updateTraining(id, body, c.get("userId"), {
        isAdmin: true,
        canPublish,
        canPin,
      });
      return c.json({ data: updated });
    },
  ),
);

/**
 * 删除任意题单。
 * DELETE /api/v1/admin/catalog/trainings/:id
 * 需 training:delete_any；响应 204。
 */
router.delete(
  "/trainings/:id",
  adminVersionMiddleware(async (c) => {
    const id = await resolveTrainingId(c.req.param("id") as string);
    return (await getTraining(id)).updated_at;
  }),
  auditRoute(
    {
      action: "trainings.delete",
      target: (c) => ({ type: "training", id: c.req.param("id")! }),
      buildDetail: (c) => ({
        action: "trainings.delete",
        id: c.req.param("id")!,
      }),
    },
    async (c) => {
      await assertPermission(c, "training:delete_any");
      const id = await resolveTrainingId(c.req.param("id") as string);
      await deleteTraining(id, c.get("userId"), true);
      return c.body(null, 204);
    },
  ),
);

export default router;
