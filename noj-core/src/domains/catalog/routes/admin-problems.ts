import { Hono } from "hono";
import type { AuthEnv } from "./../../identity/index.ts";
import { BadRequestError } from "./../../../shared/base/errors.ts";
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
 * - GET /problems 全量题目列表（含 U 型和 P 型）
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

export default router;
