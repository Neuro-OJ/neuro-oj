import { Hono } from "hono";
import type { AuthEnv } from "./../../identity/index.ts";
import { BadRequestError } from "./../../../shared/base/errors.ts";
import type { EffectiveVersionPolicy } from "./../../../shared/versioning/types.ts";
import {
  setContestProblemEffectiveVersionPolicy,
  setProblemEffectiveVersionPolicy,
  upgradeContestProblemPinnedVersion,
} from "../../submission/index.ts";

/**
 * 有效版本策略与竞赛固定版本路由（Handbook §4.5）。
 *
 * 挂载前缀 `/api/v1/admin`（见 admin/index.ts），组级已由 `adminMiddleware`
 * 强制管理员权限：
 * - `PUT /problems/:id/effective-version-policy`
 * - `PUT /contests/:contestId/problems/:problemId/effective-version-policy`
 * - `PUT /contests/:contestId/problems/:problemId/version`
 *
 * 三个动作互相独立（发布新版本 / 重测指定版本 / 切换有效策略），策略切换在事务提交
 * 后立即生效（响应携带新 revision 与受影响提交数）。
 */

const router = new Hono<AuthEnv>();

/** 解析并校验 `EffectiveVersionPolicy`（不接受未经校验的客户端对象）。 */
function parsePolicy(value: unknown): EffectiveVersionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError(
      "policy 必须是对象：{ mode: 'any' } 或 { mode: 'exact', version_id }",
    );
  }
  const record = value as Record<string, unknown>;
  if (record.mode === "any") return { mode: "any" };
  if (record.mode === "exact") {
    const versionId = typeof record.version_id === "string"
      ? record.version_id.trim()
      : "";
    if (!versionId) {
      throw new BadRequestError("exact 策略必须给出 version_id");
    }
    return { mode: "exact", version_id: versionId };
  }
  throw new BadRequestError("policy.mode 只允许 any 或 exact");
}

/** 解析策略 revision（乐观锁，必填非负整数）。 */
function parseExpectedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new BadRequestError("expected_revision 必须为非负整数");
  }
  return value;
}

/** 切换题库有效版本策略（`any` / `exact(X)`，不修改最新版指针）。 */
router.put("/problems/:id/effective-version-policy", async (c) => {
  const problemId = c.req.param("id") as string;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new BadRequestError("请求体必须是 JSON 对象");
  }
  const result = await setProblemEffectiveVersionPolicy(problemId, {
    policy: parsePolicy(body.policy),
    expectedRevision: parseExpectedRevision(body.expected_revision),
    actorId: (c.get("userId") as string | undefined) ?? null,
  });
  return c.json({ data: result });
});

/** 切换「竞赛 × 题目」有效版本策略（`exact(X)` 同时固定作答版本为 X）。 */
router.put(
  "/contests/:contestId/problems/:problemId/effective-version-policy",
  async (c) => {
    const contestId = c.req.param("contestId") as string;
    const problemId = c.req.param("problemId") as string;
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new BadRequestError("请求体必须是 JSON 对象");
    }
    const result = await setContestProblemEffectiveVersionPolicy(
      contestId,
      problemId,
      {
        policy: parsePolicy(body.policy),
        expectedRevision: parseExpectedRevision(body.expected_revision),
        actorId: (c.get("userId") as string | undefined) ?? null,
      },
    );
    return c.json({ data: result });
  },
);

/**
 * 单独升级竞赛固定作答版本。
 *
 * 固定版本升级本身不撤销旧成绩；若现有 `exact` 策略与新固定版本冲突且请求未同时
 * 给出新策略，服务层返回 409（不静默改动策略）。
 */
router.put("/contests/:contestId/problems/:problemId/version", async (c) => {
  const contestId = c.req.param("contestId") as string;
  const problemId = c.req.param("problemId") as string;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new BadRequestError("请求体必须是 JSON 对象");
  }
  const versionId = typeof body.version_id === "string"
    ? body.version_id.trim()
    : "";
  if (!versionId) throw new BadRequestError("缺少必填字段：version_id");
  const result = await upgradeContestProblemPinnedVersion(
    contestId,
    problemId,
    {
      versionId,
      ...(body.policy !== undefined
        ? { policy: parsePolicy(body.policy) }
        : {}),
      expectedRevision: body.expected_revision === undefined
        ? undefined
        : parseExpectedRevision(body.expected_revision),
      actorId: (c.get("userId") as string | undefined) ?? null,
    },
  );
  return c.json({ data: result });
});

export default router;
