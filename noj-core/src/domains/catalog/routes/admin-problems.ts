import { Hono } from "hono";
import { eq, inArray, sql } from "drizzle-orm";
import type { AuthEnv } from "./../../identity/index.ts";
import { assertPermission } from "./../../identity/index.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import {
  BadRequestError,
  NotFoundError,
} from "./../../../shared/base/errors.ts";
import { getDb } from "./../../../shared/db/connection.ts";
import { problems } from "./../../../shared/db/schema.ts";
import { listAllProblems } from "../services/problems/problems.ts";
import { resolveProblem } from "../services/problem-resolve.ts";
import {
  getProblemTemplate,
  getSupportPackageBytes,
} from "../services/support-package.ts";
import { validateJudgeImageWithKind } from "../../system/index.ts";

/**
 * 管理端题目管理路由（挂载前缀 /api/v1/admin，见 admin/index.ts）。
 *
 * 提供：
 * - GET  /problems             全量题目列表（含 U 型和 P 型）
 * - GET  /problems/review      题目评定队列（待转公开 / 待转 P）
 * - POST /problems/review      批量转公开 / 批量 U→P
 */
const router = new Hono<AuthEnv>();

/** 发布前预检：结果绑定题目当前配置与支持包内容的 SHA-256 指纹。 */
router.get("/problems/:id/preflight", async (c) => {
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
 * GET /api/v1/admin/problems
 */
router.get("/problems", async (c) => {
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
 * GET /api/v1/admin/problems/review?queue=public|p
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
 * POST /api/v1/admin/problems/review
 * body: { problem_ids: string[], action: "to_public" | "to_p" }
 * - to_public：批量将 U 型题转为 public
 * - to_p：批量将 U 型题转为 P 型（需 problem:create_p，admin:full_access 通配）
 */
router.post("/problems/review", async (c) => {
  await assertPermission(c, "problem:create_p");
  const body = await parseJsonBody<{
    problem_ids?: unknown;
    ids?: unknown;
    action?: unknown;
  }>(c);

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
});

export default router;
