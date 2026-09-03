import { type Context, Hono } from "hono";
import busboy from "busboy";
import { Readable } from "node:stream";
import type { OptionalAuthEnv } from "../../../middleware/auth.ts";
import {
  authMiddleware,
  optionalAuthMiddleware,
} from "../../../middleware/auth.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "./../../../shared/base/errors.ts";
import {
  buildPaginationMeta,
  parsePagination,
} from "./../../../shared/http/pagination.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import { createFileStream } from "./../../../shared/http/file-stream.ts";
import { checkPermission } from "../../../lib/permissions.ts";
import { getContestRanking } from "../services/contest-ranking.ts";
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
  registerForContest,
  resolveContestId,
} from "../services/contests.ts";
import {
  createArtifactSubmission,
  createSubmission,
  listSubmissions,
} from "../../submission/index.ts";
import { isValidContestType } from "../../../types/contests.ts";
import { createActivity } from "../../community/index.ts";
import { enforceContestSubmissionRateLimit } from "../../../lib/hardening-rate-limit.ts";

const contests = new Hono<OptionalAuthEnv>();
const MAX_CODE_LENGTH = 100 * 1024;

/**
 * 解析竞赛 artifact 提交的 multipart/form-data 请求。
 * 一旦 `problem_id` 与文件流都就绪就立即 resolve，由服务层马上消费文件流，
 * 避免 busboy 大文件死锁。
 */
function parseContestArtifactMultipart(
  c: Context,
): Promise<{
  problem_id: string;
  file_name: string;
  file_stream: ReadableStream<Uint8Array>;
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
        });
      }
    }

    bb.on("field", (name: string, val: string) => {
      if (name === "problem_id") problemId = val;
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
  const result = await listContests({ page, perPage, type });
  return c.json({
    data: result.data,
    pagination: buildPaginationMeta(page, perPage, result.total),
  });
});

/**
 * POST /:id/register —— 注册参赛（公开竞赛自助注册，可带密码）。
 * 权限：登录。path：id（UUID/public_id）。body：{ password? }。
 * 响应：201 { message }。
 */
contests.post("/:id/register", authMiddleware, async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const rawBody = await c.req.text();
  let body: { password?: string } = {};
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody) as { password?: string };
    } catch {
      throw new BadRequestError("请求体格式错误：需要有效的 JSON");
    }
  }
  await registerForContest(
    contestId,
    c.var.userId as string,
    body.password,
  );
  await createActivity(
    c.var.userId as string,
    "contest_joined",
    "contest",
    contestId,
    {},
  );
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
    await checkPermission(c, "submission:read_all"),
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
    await checkPermission(c, "submission:read_all"),
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
  if (
    !contest.is_public && !await checkPermission(c, "submission:read_all") &&
    !contest.is_registered
  ) {
    throw new NotFoundError("竞赛不存在");
  }
  const type = c.req.query("type") ?? contest.type;
  if (!isValidContestType(type)) {
    throw new BadRequestError("排名类型不合法");
  }
  const isAdmin = await checkPermission(c, "submission:read_all");
  const data = await getContestRanking(
    contestId,
    type,
    isAdmin,
    c.var.userId,
  );
  return c.json({ data });
});

/**
 * POST /:id/submit —— 提交竞赛题目（支持代码 JSON 或 artifact multipart）。
 * 权限：登录且为参赛者（管理员可豁免），仅竞赛进行期间。path：id。
 * body（JSON）：{ problem_id, language, code, file_name? } 或 multipart 文件。
 * 响应：201 { data }。
 */
contests.post("/:id/submit", authMiddleware, async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const userId = c.var.userId as string;
  await enforceContestSubmissionRateLimit(c, userId);
  const contest = await getContest(contestId, userId);
  if (
    computeContestStatus(contest.start_time, contest.end_time) !== "running"
  ) {
    throw new ForbiddenError("仅可在竞赛进行期间提交");
  }
  if (
    !await isParticipant(contestId, userId) &&
    !await checkPermission(c, "submission:read_all")
  ) {
    throw new ForbiddenError("仅参赛者可提交");
  }

  const contentType = c.req.header("content-type") ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    const parsed = await parseContestArtifactMultipart(c);
    const contestProblems = await getContestProblems(contestId, userId);
    if (
      !contestProblems.some((item) => item.problem_id === parsed.problem_id)
    ) {
      throw new BadRequestError("题目不属于该竞赛");
    }
    const data = await createArtifactSubmission(
      userId,
      { ...parsed, contest_id: contestId },
      contestId,
    );
    return c.json({ data }, 201);
  }

  const body = await parseJsonBody<{
    problem_id?: string;
    language?: string;
    code?: string;
    file_name?: string;
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
  const contestProblems = await getContestProblems(contestId, userId);
  if (!contestProblems.some((item) => item.problem_id === body.problem_id)) {
    throw new BadRequestError("题目不属于该竞赛");
  }

  const data = await createSubmission(
    userId,
    {
      problem_id: body.problem_id,
      language: body.language,
      code: body.code,
      file_name: body.file_name,
      contest_id: contestId,
    },
    contestId,
  );
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
  const result = await listSubmissions({
    contestId,
    userId,
    page,
    perPage,
  });
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
  // 私有竞赛门禁：与 GET /:id 一致，仅 admin/参赛者可见（创建者通常为 admin）
  const contest = await getContest(contestId, userId);
  if (
    !contest.is_public && !await checkPermission(c, "submission:read_all") &&
    !contest.is_registered
  ) {
    throw new NotFoundError("竞赛不存在");
  }
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
  const data = await getContest(contestId, c.var.userId);
  if (
    !data.is_public && !await checkPermission(c, "submission:read_all") &&
    !data.is_registered
  ) {
    throw new NotFoundError("竞赛不存在");
  }
  return c.json({ data });
});

export default contests;
