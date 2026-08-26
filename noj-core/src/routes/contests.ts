import { Hono, type Context } from "hono";
import busboy from "busboy";
import { Readable } from "node:stream";
import type { OptionalAuthEnv } from "../middleware/auth.ts";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../lib/errors.ts";
import { buildPaginationMeta, parsePagination } from "../lib/pagination.ts";
import { parseJsonBody } from "../lib/request.ts";
import { checkPermission } from "../lib/permissions.ts";
import { getContestRanking } from "../services/contest/contest-ranking.ts";
import {
  createClarification,
  listClarifications,
  replyToClarification,
} from "../services/contest/contest-clarifications.ts";
import {
  computeContestStatus,
  getContest,
  getContestProblems,
  isParticipant,
  listContests,
  registerForContest,
  resolveContestId,
} from "../services/contest/contests.ts";
import {
  createArtifactSubmission,
  createSubmission,
  listSubmissions,
} from "../services/submissions/submissions.ts";
import { isValidContestType } from "../types/contests.ts";
import { createActivity } from "../services/community/community.ts";
import { enforceContestSubmissionRateLimit } from "../lib/hardening-rate-limit.ts";

const contests = new Hono<OptionalAuthEnv>();
const MAX_CODE_LENGTH = 100 * 1024;

/**
 * 解析竞赛 artifact 提交的 multipart/form-data 请求。
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

    bb.on("field", (name: string, val: string) => {
      if (name === "problem_id") problemId = val;
    });
    bb.on("file", (name: string, file: any, info: any) => {
      if (name === "file") {
        fileName = info.filename;
        fileStream = Readable.toWeb(file) as unknown as ReadableStream<Uint8Array>;
      } else {
        file.resume();
      }
    });
    bb.on("error", (err: unknown) => reject(err));
    bb.on("close", () => {
      if (!problemId || !fileName || !fileStream) {
        reject(new BadRequestError("缺少必填字段：problem_id 或 file"));
        return;
      }
      resolve({ problem_id: problemId, file_name: fileName, file_stream: fileStream });
    });

    Readable.fromWeb(c.req.raw.body as any).pipe(bb);
  });
}

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
