import { type Context, Hono } from "hono";
import busboy from "busboy";
import { Readable } from "node:stream";
import type { OptionalAuthEnv } from "../../../shared/http/hono-env.ts";
import {
  authMiddleware,
  optionalAuthMiddleware,
} from "../../access/identity/middleware/auth.ts";
import { userActorFromAuthenticatedId } from "../../access/contracts/actor.ts";
import {
  createContestCommand,
  registerForContestCommand,
} from "../../application/contests.ts";
import {
  composeEvaluationAdmissionContext,
  listContestSubmissionsCommand,
  requireEvaluationVersion,
  submitArtifactCommand,
  submitCodeCommand,
} from "../../application/evaluations.ts";
import { DEFAULT_DOMAIN_SLUG } from "../../../shared/workspace/types.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import {
  buildPaginationMeta,
  parsePagination,
} from "../../../shared/http/pagination.ts";
import { parseJsonBody } from "../../../shared/http/request.ts";
import { createFileStream } from "../../../shared/http/file-stream.ts";
import { checkPermission } from "../../access/contracts/cross-module/identity_services_security_permissions.ts";
import {
  getContestRankingView,
  getLatestContestRankingSnapshot,
} from "../services/contest-ranking.ts";
import {
  createClarification,
  listClarifications,
  replyToClarification,
} from "../services/contest-clarifications.ts";
import {
  computeContestStatus,
  getContest,
  getContestProblems,
  isParticipant,
  listContests,
  resolveContestId,
} from "../services/contests.ts";
import type { CreateContestInput } from "../types/contests.ts";
import { isValidContestType } from "../types/contests.ts";
import { resolveDefaultContestAccess } from "../services/default-access.ts";
import {
  enforceContestRegisterRateLimit,
  enforceContestSubmissionRateLimit,
} from "../../platform/contracts/cross-module/system_services_hardening-rate-limit.ts";

const contests = new Hono<OptionalAuthEnv>();
const MAX_CODE_LENGTH = 100 * 1024;
for (const path of ["/:id", "/:id/*"]) {
  contests.use(path, optionalAuthMiddleware, async (c, next) => {
    await resolveDefaultContestAccess(c.req.param("id")!, c.var.userId ?? null);
    await next();
  });
}

/**
 * 解析竞赛 artifact 提交的 multipart/form-data 请求。
 * 一旦 `problem_id` 与文件流都就绪就立即 resolve，由服务层马上消费文件流，
 * 避免 busboy 大文件死锁。
 *
 * `version_id` 为客户端携带的作答版本（Handbook §4.2）：字段须排在文件之前
 * （浏览器 FormData 按 append 顺序发送），与 `problem_id` 同时读出。
 */
function parseContestArtifactMultipart(
  c: Context,
): Promise<{
  problem_id: string;
  file_name: string;
  file_stream: ReadableStream<Uint8Array>;
  version_id?: string;
}> {
  return new Promise((resolve, reject) => {
    const contentType = c.req.header("content-type");
    if (!contentType) {
      reject(new BadRequestError("缺少 Content-Type"));
      return;
    }
    const bb = busboy({ headers: { "content-type": contentType } });
    let problemId = "";
    let fileName = "";
    let versionId = "";
    let fileStream: ReadableStream<Uint8Array> | null = null;
    let resolved = false;

    /** 当 problem_id、文件名与文件流均已就绪后一次性 resolve 解析结果。 */
    function maybeResolve() {
      if (resolved) return;
      if (problemId && fileName && fileStream) {
        resolved = true;
        resolve({
          problem_id: problemId,
          file_name: fileName,
          file_stream: fileStream,
          ...(versionId ? { version_id: versionId } : {}),
        });
      }
    }

    bb.on("field", (name: string, val: string) => {
      if (name === "problem_id") problemId = val;
      if (name === "version_id") versionId = val;
      maybeResolve();
    });
    bb.on("file", (name: string, file: unknown, info: { filename: string }) => {
      if (name === "file") {
        fileName = info.filename;
        fileStream = createFileStream(file as import("node:stream").Readable);
        maybeResolve();
      } else {
        (file as import("node:stream").Readable).resume();
      }
    });
    bb.on("error", (err: unknown) => {
      if (!resolved) reject(err);
    });
    bb.on("close", () => {
      if (!resolved) {
        reject(new BadRequestError("缺少必填字段：problem_id 或 file"));
      }
    });

    Readable.fromWeb(
      c.req.raw.body as unknown as import("node:stream/web").ReadableStream,
    ).pipe(bb);
  });
}

/**
 * 校验当前用户对竞赛题目的访问权限：竞赛未结束且非管理员时要求为参赛者，
 * 竞赛未开始（pending）一律禁止访问。
 *
 * @param contestId 竞赛 UUID
 * @param userId 当前用户 ID
 * @param isAdmin 是否管理员（管理员跳过参赛校验）
 * @returns 竞赛响应
 * @throws {ForbiddenError} 无访问权限或竞赛尚未开始时
 */
async function requireContestAccess(
  contestId: string,
  userId: string,
  isAdmin = false,
): Promise<Awaited<ReturnType<typeof getContest>>> {
  const contest = await getContest(contestId, userId);
  if (
    contest.status !== "ended" && !isAdmin &&
    !await isParticipant(contestId, userId)
  ) {
    throw new ForbiddenError("仅参赛者可访问竞赛题目");
  }
  if (contest.status === "pending") {
    throw new ForbiddenError("竞赛尚未开始");
  }
  return contest;
}

/**
 * 比赛已无密码 / 邀请码 / 公开范围分类。
 *
 * 旧客户端仍会带 `password` / `kind` / `is_public`。静默忽略最糟：调用方会以为凭据
 * 被接受了，实际只是走了统一报名。因此显式 400 并指出字段名。
 *
 * @param body 已解析的请求体
 * @throws {BadRequestError} 出现任一遗留字段
 */
function assertNoLegacyContestCredential(body: Record<string, unknown>): void {
  const legacy = ["password", "kind", "is_public"].filter((key) =>
    body !== null && typeof body === "object" && key in body
  );
  if (legacy.length > 0) {
    throw new BadRequestError(
      `比赛不再使用 ${
        legacy.join(" / ")
      }：报名由域访问权决定，请移除这些字段后重试`,
      "CONTEST_LEGACY_FIELD",
    );
  }
}

/**
 * GET / —— 竞赛公开列表（可选分页与类型筛选）。
 * 权限：公开。query：page、perPage、type。响应：{ data, pagination }。
 */
contests.get("/", async (c) => {
  const { page, perPage } = parsePagination(c);
  const typeQuery = c.req.query("type");
  if (typeQuery && !isValidContestType(typeQuery)) {
    throw new BadRequestError("竞赛类型不合法");
  }
  const type = typeQuery && isValidContestType(typeQuery)
    ? typeQuery
    : undefined;
  const result = await listContests({
    page,
    perPage,
    type,
    defaultDomainOnly: true,
  });
  return c.json({
    data: result.data,
    pagination: buildPaginationMeta(page, perPage, result.total),
  });
});

/**
 * POST / —— 创建邀请赛（普通用户）或公开赛（管理员）。
 * 权限：登录且具备 contest:create。body：CreateContestInput。
 * 响应：201 { data }。
 */
contests.post("/", authMiddleware, async (c) => {
  const body = await parseJsonBody<
    CreateContestInput & Record<string, unknown>
  >(
    c,
  );
  assertNoLegacyContestCredential(body as unknown as Record<string, unknown>);
  const actor = userActorFromAuthenticatedId(c.var.userId!);
  const data = await createContestCommand(actor, body, {
    domainSlug: DEFAULT_DOMAIN_SLUG,
  });
  return c.json({ data }, 201);
});

/**
 * POST /:id/register —— 注册参赛（统一报名，无需任何凭据）。
 * 权限：登录。path：id（UUID/public_id）。body：可省略。
 * 响应：201 { message }。
 */
contests.post("/:id/register", authMiddleware, async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  /**
   * 报名请求体历史上是可选的（`{}` 或干脆不发）。比赛不再有密码/邀请码，但旧客户端
   * 仍会带 `password`：出现这些字段时显式 400，而不是静默忽略——否则调用方会以为
   * 自己的凭据被接受了。空 body 仍然照常受理，保持既有调用方兼容。
   */
  const rawBody = await c.req.text();
  if (rawBody.trim()) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new BadRequestError("请求体格式错误：需要有效的 JSON");
    }
    assertNoLegacyContestCredential(parsed);
  }
  await enforceContestRegisterRateLimit(c, contestId);
  const actor = userActorFromAuthenticatedId(c.var.userId!);
  await registerForContestCommand(actor, contestId, {
    domainSlug: DEFAULT_DOMAIN_SLUG,
  });
  // 注：此前此处广播 `contest_joined` 自动动态（会对外暴露私密邀请赛标题），
  // 该功能已按审计 VULN-08 整体下线，不再产生任何社区动态事件。
  return c.json({ message: "竞赛注册成功" }, 201);
});

/**
 * GET /:id/problems —— 获取竞赛题目列表（含当前用户作答状态）。
 * 权限：登录且为参赛者（管理员可豁免）。path：id。响应：{ data }。
 */
contests.get("/:id/problems", authMiddleware, async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const userId = c.var.userId as string;
  await requireContestAccess(
    contestId,
    userId,
    await checkPermission(c, "contest:manage"),
  );
  const data = await getContestProblems(contestId, userId);
  return c.json({ data });
});

/**
 * GET /:id/problems/:label —— 获取竞赛某道题目的详情（按题目标签）。
 * 权限：登录且为参赛者（管理员可豁免）。path：id、label。响应：{ data }。
 */
contests.get("/:id/problems/:label", authMiddleware, async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const userId = c.var.userId as string;
  await requireContestAccess(
    contestId,
    userId,
    await checkPermission(c, "contest:manage"),
  );
  const problem = (await getContestProblems(contestId, userId)).find(
    (item) => item.label === c.req.param("label"),
  );
  if (!problem) {
    throw new NotFoundError("竞赛题目不存在");
  }
  return c.json({ data: problem });
});

/**
 * GET /:id/ranking —— 获取竞赛排名（类 Kaggle）。
 * 权限：公开竞赛匿名可见；进行中非管理员仅返回自己的排名。path：id。query：type?。
 * 响应：{ data }。
 */
contests.get("/:id/ranking", optionalAuthMiddleware, async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const contest = await getContest(contestId, c.var.userId);
  const isAdmin = await checkPermission(c, "contest:manage");
  // 访问由 Domain 决定：无域入口已由 `resolveDefaultContestAccess` 门控到 main 域，
  // 这里不再用已废弃的 `is_public` 二次判定（它恒为 true，等于没有检查）。
  if (!isAdmin && contest.ranking_visibility === "hidden") {
    throw new NotFoundError("竞赛排名不可见");
  }
  if (
    !isAdmin && contest.ranking_visibility === "participants" &&
    !contest.is_registered
  ) {
    throw new ForbiddenError("仅参赛者可查看正式成绩");
  }
  const type = c.req.query("type") ?? contest.type;
  if (!isValidContestType(type)) {
    throw new BadRequestError("排名类型不合法");
  }
  const result = await getContestRankingView(
    contestId,
    type,
    isAdmin,
    c.var.userId,
  );
  return c.json({
    data: result.rows,
    view: result.view,
    ranking_visibility: result.ranking_visibility,
    freeze_start_time: result.freeze_start_time,
    freeze_end_time: result.freeze_end_time,
    settlement_pending: result.settlement_pending,
    admin_live: isAdmin && result.view === "live",
  });
});

/**
 * GET /:id/final-ranking —— 查看已发布的正式成绩。
 * 与实时排名分离，返回快照版本和发布时间，避免重测后误把实时成绩当作正式成绩。
 */
contests.get("/:id/final-ranking", optionalAuthMiddleware, async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const contest = await getContest(contestId, c.var.userId);
  const isAdmin = await checkPermission(c, "contest:manage");
  if (!isAdmin && contest.ranking_visibility === "hidden") {
    throw new NotFoundError("竞赛排名不可见");
  }
  if (
    !isAdmin && contest.ranking_visibility === "participants" &&
    !contest.is_registered
  ) {
    throw new ForbiddenError("仅参赛者可查看正式成绩");
  }
  const snapshot = await getLatestContestRankingSnapshot(contestId);
  if (!snapshot) throw new NotFoundError("尚未发布正式成绩");
  return c.json({
    data: snapshot.rows,
    result_type: "official",
    snapshot: {
      version: snapshot.version,
      note: snapshot.note,
      created_at: snapshot.created_at,
    },
  });
});

/**
 * POST /:id/submit —— 提交竞赛题目（支持代码 JSON 或 artifact multipart）。
 * 权限：登录且为参赛者（管理员可豁免），仅竞赛进行期间。path：id。
 * body（JSON）：{ problem_id, language, code, version_id, file_name? } 或 multipart 文件。
 * `version_id` 必须是该竞赛的固定版本，不一致 → 409 CONTEST_PROBLEM_VERSION_CHANGED。
 * 响应：201 { data }。
 */
contests.post("/:id/submit", authMiddleware, async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const userId = c.var.userId as string;
  const contest = await getContest(contestId, userId);
  if (
    computeContestStatus(contest.start_time, contest.end_time) !== "running"
  ) {
    throw new ForbiddenError("仅可在竞赛进行期间提交");
  }
  const isAdmin = await checkPermission(c, "contest:manage");
  if (
    !await isParticipant(contestId, userId) && !isAdmin
  ) {
    throw new ForbiddenError("仅参赛者可提交");
  }

  const contentType = c.req.header("content-type") ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    const parsed = await parseContestArtifactMultipart(c);
    if (!parsed.version_id) await parsed.file_stream.cancel().catch(() => {});
    const versionId = requireEvaluationVersion(parsed.version_id);
    const contestProblems = await getContestProblems(contestId, userId);
    const contestProblem = contestProblems.find(
      (item) => item.problem_id === parsed.problem_id,
    );
    if (!contestProblem) {
      throw new BadRequestError("题目不属于该竞赛");
    }
    await enforceContestSubmissionRateLimit(c, userId);
    const actor = userActorFromAuthenticatedId(userId);
    const context = await composeEvaluationAdmissionContext(actor, {
      problemId: parsed.problem_id,
      versionId,
      contestId,
    });
    // 复用成员校验时已取得的 submission_mode，避免为分派再查一次题目。
    const data = await submitArtifactCommand(
      actor,
      context,
      { ...parsed, version_id: versionId, contest_id: contestId },
      contestProblem.submission_mode === "prediction"
        ? "prediction"
        : "artifact",
    );
    return c.json({ data }, 201);
  }

  const body = await parseJsonBody<{
    problem_id?: string;
    language?: string;
    code?: string;
    file_name?: string;
    version_id?: string;
  }>(c);
  if (!body.problem_id || !body.language || !body.code) {
    throw new BadRequestError("缺少必填字段：problem_id、language 或 code");
  }
  if (typeof body.code !== "string") {
    throw new BadRequestError("code 字段必须为字符串");
  }
  if (body.code.length > MAX_CODE_LENGTH) {
    throw new BadRequestError(
      `代码长度超过限制（${MAX_CODE_LENGTH} 字符），请精简后重新提交`,
    );
  }

  await enforceContestSubmissionRateLimit(c, userId);
  const contestProblems = await getContestProblems(contestId, userId);
  if (!contestProblems.some((item) => item.problem_id === body.problem_id)) {
    throw new BadRequestError("题目不属于该竞赛");
  }

  const actor = userActorFromAuthenticatedId(userId);
  const versionId = requireEvaluationVersion(body.version_id);
  const context = await composeEvaluationAdmissionContext(actor, {
    problemId: body.problem_id,
    versionId,
    contestId,
  });
  const data = await submitCodeCommand(actor, context, {
    problem_id: body.problem_id,
    language: body.language,
    code: body.code,
    file_name: body.file_name,
    contest_id: contestId,
    version_id: versionId,
  });
  return c.json({ data }, 201);
});

/**
 * GET /:id/my-submissions —— 获取当前用户在竞赛中的提交列表。
 * 权限：登录且为参赛者。path：id。query：page、perPage。响应：{ data, pagination }。
 */
contests.get("/:id/my-submissions", authMiddleware, async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const userId = c.var.userId as string;
  await getContest(contestId);
  if (!await isParticipant(contestId, userId)) {
    throw new ForbiddenError("仅参赛者可查看竞赛提交");
  }
  const { page, perPage } = parsePagination(c);
  const result = await listContestSubmissionsCommand(
    userActorFromAuthenticatedId(userId),
    contestId,
    page,
    perPage,
  );
  return c.json({
    data: result.data,
    pagination: buildPaginationMeta(page, perPage, result.total),
  });
});

/**
 * GET /:id/clarifications —— 获取竞赛答疑列表（按可见性过滤）。
 * 权限：公开竞赛匿名可见；私有竞赛需 admin/参赛者。path：id。query：page、perPage。
 * 响应：{ data, pagination }。
 */
contests.get("/:id/clarifications", optionalAuthMiddleware, async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const userId = c.var.userId;
  // 答疑列表本身按调用者身份裁剪（私密提问只有提问者与主办方可见），域访问权
  // 已由 `/:id` 中间件的默认域门控保证，不再做一次无效的竞赛可见性判定。
  const { page, perPage } = parsePagination(c);
  const result = await listClarifications(contestId, userId, {
    page,
    perPage,
  });
  return c.json({
    data: result.data,
    pagination: buildPaginationMeta(page, perPage, result.total),
  });
});

/**
 * POST /:id/clarifications —— 参赛者提问（竞赛进行期间），可挂竞赛题目或全局。
 * 权限：登录且为参赛者。path：id。body：{ content?, problem_id? }。响应：201 { data }。
 */
contests.post("/:id/clarifications", authMiddleware, async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const userId = c.var.userId as string;
  const body = await parseJsonBody<{
    content?: string;
    problem_id?: string;
  }>(c);
  const data = await createClarification(contestId, userId, body);
  return c.json({ data }, 201);
});

/**
 * POST /:id/clarifications/:clarId/reply —— 主办方回复提问（公开或私密）。
 * 权限：登录且为 admin 或竞赛创建者。path：id、clarId。body：{ content?, is_public? }。
 * 响应：201 { data }。
 */
contests.post(
  "/:id/clarifications/:clarId/reply",
  authMiddleware,
  async (c) => {
    const contestId = await resolveContestId(c.req.param("id") as string);
    const clarId = c.req.param("clarId") as string;
    const userId = c.var.userId as string;
    const body = await parseJsonBody<{ content?: string; is_public?: boolean }>(
      c,
    );
    const data = await replyToClarification(contestId, clarId, userId, body);
    return c.json({ data }, 201);
  },
);

/**
 * GET /:id —— 获取竞赛详情（私有竞赛需 admin/注册参赛者可见）。
 * 权限：公开竞猜匿名可见；私有竞赛需 admin 或参赛者。path：id。响应：{ data }。
 */
contests.get("/:id", optionalAuthMiddleware, async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  // 域访问权由 `resolveDefaultContestAccess` 中间件保证；此处直接返回域内可见的详情。
  const data = await getContest(contestId, c.var.userId);
  return c.json({ data });
});

export default contests;
