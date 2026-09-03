import { Hono } from "hono";
import {
  type AuthEnv,
  authMiddleware,
  optionalAuthMiddleware,
} from "./../../identity/index.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import {
  BadRequestError,
  ForbiddenError,
  UnauthorizedError,
} from "./../../../shared/base/errors.ts";
import { parsePagination } from "./../../../shared/http/pagination.ts";
import { checkPermission } from "./../../identity/index.ts";
import {
  enforceObjectiveSubmitRateLimit,
  enforceProblemCreateRateLimit,
  enforceProblemImportRateLimit,
} from "../../system/index.ts";
import { withActorContext } from "../../../lib/requestContext.ts";
import {
  createProblem,
  deleteProblem,
  listProblems,
  updateProblem,
} from "../services/problems/problems.ts";
import { applyAlgorithmTagVisibility } from "../services/problems/problems-list.ts";
import { resolveProblem } from "./../services/problem-resolve.ts";
import {
  ADMIN_FULL_ACCESS,
  resolvePermissions,
} from "./../../identity/index.ts";
import type {
  CreateProblemInput,
  ProblemListQuery,
  UpdateProblemInput,
} from "./../types/problems.ts";
import {
  deleteSupportPackage,
  getProblemTemplate,
  getSupportPackageBytes,
  MAX_SUPPORT_PACKAGE_SIZE,
} from "../services/support-package.ts";
import { importProblemBundle } from "../services/problems/problem-bundle.ts";
import {
  assertObjectivePaper,
  createQuestion,
  deleteQuestion,
  getObjectiveSubmission,
  getPaperOrThrow,
  isPaperOwnerOrAdmin,
  listObjectiveSubmissions,
  listPaperQuestions,
  submitObjectivePaper,
  updateQuestion,
} from "../../objective/index.ts";
import type {
  CreateQuestionInput,
  SubmitObjectiveInput,
  UpdateQuestionInput,
} from "../../objective/index.ts";

const router = new Hono<AuthEnv>();

/**
 * 获取题目列表。
 * 支持分页与筛选：?page=1&limit=20&difficulty=easy&tag=xxx&keyword=xxx&type=U&number=1001
 */
router.get("/", optionalAuthMiddleware, async (c) => {
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);

  // 校验非数字输入
  if (Number.isNaN(page) || Number.isNaN(limit)) {
    throw new BadRequestError("分页参数 page 和 limit 必须为数字");
  }

  const query: ProblemListQuery = {
    page: Math.max(1, page),
    limit: Math.min(100, Math.max(1, limit)),
  };

  const difficulty = c.req.query("difficulty");
  if (difficulty) query.difficulty = difficulty;

  const tagId = c.req.query("tag");
  if (tagId) query.tag = tagId;

  const keyword = c.req.query("keyword");
  if (keyword) query.keyword = keyword;

  const type = c.req.query("type");
  if (type) query.type = type;

  const numberStr = c.req.query("number");
  if (numberStr) {
    const number = parseInt(numberStr, 10);
    if (!Number.isNaN(number)) query.number = number;
  }

  const ownerId = c.req.query("owner_id");
  if (ownerId) query.owner_id = ownerId;

  // NOJ-103：禁止匿名/普通用户批量枚举他人 U 型题。
  // U 型列表只能查本人（或由 problem:read_all/admin 查全部）。
  const requestedType = (query.type || "P").toUpperCase();
  if (requestedType === "U") {
    const userId = c.get("userId") as string | undefined;
    if (!userId) {
      throw new UnauthorizedError("请先登录");
    }
    const isAdmin = await checkPermission(c, "problem:read_all");
    if (ownerId && ownerId !== userId && !isAdmin) {
      throw new ForbiddenError("无权查看其他用户的 U 型题列表");
    }
    if (!ownerId && !isAdmin) {
      // 非管理员未指定 owner 时收窄为本人，避免匿名枚举全量 U 型题。
      query.owner_id = userId;
    }
  }

  const result = await listProblems(query);
  return c.json({
    data: result.items,
    total: result.total,
    page: result.page,
    limit: result.limit,
  });
});

/**
 * 客观题提交历史（本人；admin 可查他人）。
 * 注意：静态路径须在 /:id 之前注册（Hono 按注册顺序匹配参数路由）。
 * GET /api/v1/problems/submissions?paper_id=&contest_id=&user_id=&page=&per_page=
 */
router.get("/submissions", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const userRole = c.get("userRole");
  const { page, perPage } = parsePagination(c, {
    defaultPerPage: 20,
    maxPerPage: 100,
  });

  const result = await listObjectiveSubmissions({
    viewerId: userId,
    viewerRole: userRole,
    c,
    paperId: c.req.query("paper_id") || undefined,
    contestId: c.req.query("contest_id") || undefined,
    targetUserId: c.req.query("user_id") || undefined,
    page,
    perPage,
  });
  return c.json({ data: result });
});

/**
 * 客观题单次提交详情。
 * GET /api/v1/problems/submissions/:id
 * 仅提交者本人或 admin 可读；竞赛模式不展示解析与期望答案。
 */
router.get("/submissions/:id", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const userId = c.get("userId");
  const userRole = c.get("userRole");

  const data = await getObjectiveSubmission(id, userId, userRole, c);
  return c.json({ data });
});

/**
 * 获取题目详情（双索引：UUID 或 display_id + 算法标签可视性门控，issue #223）。
 *
 * 算法标签仅 admin / 题主 / 有通过提交（finished 且 score>0）的 viewer 可见；
 * 其余 viewer 收不到算法标签名，仅收到 has_hidden_algorithm_tags 占位标志。
 */
router.get("/:id", optionalAuthMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const problem = await resolveProblem(id);

  const userId = c.get("userId");
  const isAdmin = userId
    ? (await resolvePermissions(c)).has(ADMIN_FULL_ACCESS)
    : false;
  const data = await applyAlgorithmTagVisibility(problem, { userId, isAdmin });

  return c.json({ data });
});

/**
 * 创建题目。
 * admin 可创建任意 type，普通用户仅限 U 型。
 * POST /api/v1/problems
 */
router.post("/", authMiddleware, async (c) => {
  const body = await parseJsonBody<CreateProblemInput>(c);

  if (!body.title) {
    throw new BadRequestError("缺少必填字段：title");
  }

  if (!body.description) {
    throw new BadRequestError("缺少必填字段：description");
  }

  // 客观题套卷（is_objective）无需 runtime_config；其余必填
  if (!body.is_objective && !body.runtime_config) {
    throw new BadRequestError("缺少必填字段：runtime_config");
  }

  // NOJ-115/NOJ-116：support_package_storage_url 仅允许服务端
  // import-bundle 流程生成，客户端直传一律拒绝。
  if (
    body.support_package_storage_url !== undefined &&
    body.support_package_storage_url !== null
  ) {
    throw new BadRequestError(
      "support_package_storage_url 仅允许由服务端支持包上传/导入流程生成",
    );
  }

  const userId = c.get("userId");
  await enforceProblemCreateRateLimit(c, userId);
  const problem = await createProblem(body, userId, undefined, c);
  return c.json({ data: problem }, 201);
});

/**
 * 全量更新题目（双索引：UUID 或 display_id）。
 * 权限在服务层按 type+owner 判断。
 */
router.put("/:id", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const body = await parseJsonBody<UpdateProblemInput>(c);
  const userId = c.get("userId");

  // 双索引解析获取实际题目 ID
  const problem = await resolveProblem(id);

  // NOJ-115/NOJ-116：客户端 PUT 不得直传存储 URL。
  if (
    body.support_package_storage_url !== undefined &&
    body.support_package_storage_url !== null
  ) {
    throw new BadRequestError(
      "support_package_storage_url 仅允许由服务端支持包上传/导入流程生成",
    );
  }

  // 注入 ALS 上下文使 logAudit 可获取 actor 信息（issue #101）
  // （updateProblem 内部会记录 problems.runtime_config_changed 审计）
  return withActorContext(c, async () => {
    const updated = await updateProblem(
      problem.id,
      body,
      userId,
      undefined,
      c,
    );
    return c.json({ data: updated });
  });
});

/**
 * 删除题目（双索引：UUID 或 display_id）。
 * 权限在服务层按 type+owner 判断。
 */
router.delete("/:id", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const userId = c.get("userId");

  // 双索引解析获取实际题目 ID
  const problem = await resolveProblem(id);

  // 注入 ALS 上下文使 logAudit 可获取 actor 信息（issue #101）
  return withActorContext(c, async () => {
    await deleteProblem(problem.id, userId, undefined, c);
    return c.body(null, 204);
  });
});

/**
 * 统一题目包导入。
 * POST /api/v1/problems/import-bundle
 *
 * 唯一上传入口：id 一律服务端生成；admin 可指定 number（幂等键，按 (type, number)
 * 匹配既有题目 → 更新元数据 + 替换评测包；未命中 → 创建）；非 admin 提供 number
 * 被拒（400），普通用户导入仅创建（number 自动分配）。
 */
router.post("/import-bundle", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const userRole = c.get("userRole");
  await enforceProblemImportRateLimit(c, userId);

  // 解析 multipart/form-data
  const body = await c.req.parseBody();
  const file = body["file"];

  if (!file || !(file instanceof File)) {
    throw new BadRequestError("请上传有效的 zip 文件");
  }

  if (!file.name.toLowerCase().endsWith(".zip")) {
    throw new BadRequestError("仅支持 .zip 格式文件");
  }

  // Content-Type 校验（防御性：扩展名校验的补充）
  if (
    file.type &&
    !["application/zip", "application/x-zip-compressed"].includes(file.type)
  ) {
    throw new BadRequestError("仅支持 .zip 格式文件");
  }

  if (file.size > MAX_SUPPORT_PACKAGE_SIZE) {
    throw new BadRequestError(
      `导入包大小超过限制（最大 ${
        (MAX_SUPPORT_PACKAGE_SIZE / 1024 / 1024).toFixed(0)
      }MB）`,
    );
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());

  // 验证 zip magic bytes（PK 头：0x50, 0x4B）
  if (fileBytes.length < 4 || fileBytes[0] !== 0x50 || fileBytes[1] !== 0x4B) {
    throw new BadRequestError("文件不是有效的 zip 格式");
  }

  const result = await withActorContext(c, () =>
    importProblemBundle(
      { name: file.name, data: fileBytes },
      { userId, userRole },
      c,
    ));

  return c.json({ data: result });
});

/**
 * 下载支持包。
 * GET /api/v1/problems/:id/support-package
 * 始终通过 noj-core 代理返回文件内容（S3/MinIO 可能位于内网）。
 */
router.get("/:id/support-package", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const userId = c.get("userId");

  const problem = await resolveProblem(id);
  const zipBytes = await getSupportPackageBytes(
    problem.id,
    userId,
    undefined,
    c,
  );

  if (!zipBytes) {
    return c.json({ error: "该题目尚无支持包" }, 404);
  }

  return new Response(zipBytes as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${problem.id}.zip"`,
    },
  });
});

/**
 * 获取题目初始代码模板（starter code）。
 * GET /api/v1/problems/:id/template
 *
 * 用于编辑器在没有用户本地草稿时填入的初始代码：
 * - 按 manifest `template` 字段索引题目源码目录中的模板文件（缺省 `template.py`）
 * - 模板文件不存在 → 404
 *
 * 模板仅供前端编辑器初始填充（starter code），与评测参考实现解耦；
 * 不再回退 submission_sample.py / submission.py。
 */
router.get("/:id/template", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const problem = await resolveProblem(id);
  // 通过题号和标题共同确认源码目录归属，不能假定目录名就是展示题号。
  const tpl = await getProblemTemplate({
    number: problem.number,
    title: problem.title,
  });
  if (!tpl) {
    return c.json({ error: "该题目没有初始代码模板" }, 404);
  }
  return c.json({
    data: {
      content: tpl.content,
      language: tpl.language,
    },
  });
});

/**
 * 删除支持包。
 * DELETE /api/v1/problems/:id/support-package
 */
router.delete("/:id/support-package", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const userId = c.get("userId");
  const userRole = c.get("userRole");

  // 双索引解析获取实际题目 ID，同时获取题目信息用于权限校验
  const problem = await resolveProblem(id);

  await deleteSupportPackage(problem.id, userId, userRole, {
    type: problem.type,
    owner_id: problem.owner_id,
  }, c);

  return c.json({ data: { support_package_storage_url: null } });
});

// ── 客观题（并入 problems 体系，is_objective 标记）───────────────────────────

/**
 * 获取客观题套卷小题列表（公开可读）。
 * GET /api/v1/problems/:id/questions
 * U 型：owner/admin 视图含答案与解析；P 型：仅 admin；其余裁剪。
 */
router.get("/:id/questions", optionalAuthMiddleware, async (c) => {
  const paperId = c.req.param("id") as string;
  const userId = c.get("userId") as string | undefined;
  const userRole = c.get("userRole") as string | undefined;

  const paper = await getPaperOrThrow(paperId);
  assertObjectivePaper(paper);
  const includeAnswer = await isPaperOwnerOrAdmin(
    paper,
    userId,
    userRole,
    c,
  );
  const data = await listPaperQuestions(paper.id, includeAnswer);
  return c.json({ data });
});

/**
 * 创建客观题小题（绑定套卷）。
 * POST /api/v1/problems/:id/questions
 */
router.post("/:id/questions", authMiddleware, async (c) => {
  const paperId = c.req.param("id") as string;
  const userId = c.get("userId");
  const userRole = c.get("userRole");
  const body = await parseJsonBody<CreateQuestionInput>(c);

  const data = await createQuestion(paperId, body, userId, userRole, c);
  return c.json({ data }, 201);
});

/**
 * 更新客观题小题。
 * PUT /api/v1/problems/:id/questions/:qid
 */
router.put("/:id/questions/:qid", authMiddleware, async (c) => {
  const qid = c.req.param("qid") as string;
  const userId = c.get("userId");
  const userRole = c.get("userRole");
  const body = await parseJsonBody<UpdateQuestionInput>(c);

  const data = await updateQuestion(qid, body, userId, userRole, c);
  return c.json({ data });
});

/**
 * 删除客观题小题。
 * DELETE /api/v1/problems/:id/questions/:qid
 */
router.delete("/:id/questions/:qid", authMiddleware, async (c) => {
  const qid = c.req.param("qid") as string;
  const userId = c.get("userId");
  const userRole = c.get("userRole");

  await deleteQuestion(qid, userId, userRole, c);
  return c.body(null, 204);
});

/**
 * 提交套卷答案（即时判定）。
 * POST /api/v1/problems/:id/submit
 * body: { answers: {question_id: [...]}, contest_id?: string }
 */
router.post("/:id/submit", authMiddleware, async (c) => {
  const paperId = c.req.param("id") as string;
  const userId = c.get("userId");
  await enforceObjectiveSubmitRateLimit(c, userId);
  const body = await parseJsonBody<SubmitObjectiveInput>(c);

  if (!body.answers) {
    throw new BadRequestError("缺少必填字段：answers");
  }
  const result = await submitObjectivePaper(paperId, body, userId);
  return c.json({ data: result }, 201);
});

export default router;
