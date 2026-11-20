import { type Context, Hono } from "hono";
import {
  authMiddleware,
  optionalAuthMiddleware,
} from "../../access/identity/middleware/auth.ts";
import { type AuthEnv } from "../../../shared/http/hono-env.ts";
import { and, eq } from "drizzle-orm";
import { DEFAULT_DOMAIN_ID } from "../../../shared/workspace/types.ts";
import { getDb } from "../../../shared/db/connection.ts";
import {
  domainProblemBindings,
  problems,
  problemVersions,
} from "../../../shared/db/schema.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import {
  MAX_SAFE_PAGE,
  parsePagination,
} from "../../../shared/http/pagination.ts";
import { userActorFromAuthenticatedId } from "../../access/contracts/actor.ts";
import {
  getObjectiveSubmissionCommand,
  listObjectiveSubmissionsCommand,
} from "../../application/evaluations.ts";
import { listLlmModelAliases } from "../../platform/contracts/cross-module/gateway_services_llm-model-aliases.ts";
import { LLM_DEFAULT_MODEL_ALIAS } from "../types/problems.ts";
import {
  assertProblemEditPermissionForActor,
  listProblems,
} from "../services/problems/problems.ts";
import { getProblemDraft } from "../services/versioning/draft.ts";
import {
  getProblemVersionOrThrow,
  listProblemVersions,
  preflightProblemDraft,
  resolveProblemAnswerVersion,
} from "../services/versioning/publish.ts";
import {
  projectProblemContent,
  trimProblemContentForViewer,
} from "../services/versioning/version-read-view.ts";
import {
  getVersionSupportPackageUrl,
  resolveProblemTemplate,
} from "../services/support-package.ts";
import type { ProblemContentV1 } from "../types/problem-content.ts";
import { applyAlgorithmTagVisibility } from "../services/problems/problems-list.ts";
import { resolveProblem } from "../services/problem-resolve.ts";
import { evaluateProblemAccess } from "../services/problem-access-check.ts";
import {
  isCurrentUserAdmin,
} from "../../access/contracts/cross-module/identity_services_security_permissions.ts";
import type { ProblemListQuery } from "../types/problems.ts";
import { getSupportPackageBytes } from "../services/support-package.ts";
import { listPaperQuestionsWithAccess } from "../services/objective/objective-questions.ts";

const router = new Hono<AuthEnv>();

/**
 * 获取题目列表。
 * 支持分页与筛选：?page=1&limit=20&difficulty=easy&tag=xxx&keyword=xxx&number=1001
 */
router.get("/", optionalAuthMiddleware, async (c) => {
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);

  // 校验非数字输入
  if (Number.isNaN(page) || Number.isNaN(limit)) {
    throw new BadRequestError("分页参数 page 和 limit 必须为数字");
  }
  // page 必须有上界：offset=(page-1)*limit 会进入 PostgreSQL 的 OFFSET（bigint），
  // 9.9e16 量级的 page 使 offset 超出 bigint → PG "value ... is out of range
  // for type bigint" → 500。与 shared/http/pagination.ts 的 MAX_PAGE 保持一致。
  if (page > MAX_SAFE_PAGE) {
    throw new BadRequestError("分页参数 page 超出允许范围");
  }

  const query: ProblemListQuery = {
    page: Math.max(1, page),
    limit: Math.min(100, Math.max(1, limit)),
  };

  const difficulty = c.req.query("difficulty");
  query.judge_type = c.req.query("judge_type");
  query.judge_backend = c.req.query("judge_backend");
  if (difficulty) query.difficulty = difficulty;

  const tagId = c.req.query("tag");
  if (tagId) query.tag = tagId;

  const keyword = c.req.query("keyword");
  if (keyword) query.keyword = keyword;

  if (c.req.query("type") !== undefined) {
    throw new BadRequestError("题库筛选已取消 P/U 分类");
  }

  const numberStr = c.req.query("number");
  if (numberStr) {
    const number = parseInt(numberStr, 10);
    if (!Number.isNaN(number)) query.number = number;
  }

  const ownerId = c.req.query("owner_id");
  if (ownerId) query.owner_id = ownerId;

  const viewerId = c.get("userId") as string | undefined;
  const isAdmin = viewerId ? await isCurrentUserAdmin(c) : false;

  const result = await listProblems(query, {
    userId: viewerId,
    isAdmin,
  });
  return c.json({
    data: result.items,
    total: result.total,
    page: result.page,
    limit: result.limit,
  });
});

/**
 * 出题人可选的 LLM 模型别名（仅别名与说明，不含 Provider 与真实模型名）。
 * 静态路径须在 /:id 之前注册。
 * GET /api/v1/problems/llm-model-aliases
 * 响应：`{ data: { alias, description }[] }`，首项恒为 `default`。
 */
router.get("/llm-model-aliases", authMiddleware, async (c) => {
  const rows = await listLlmModelAliases();
  return c.json({
    data: [
      { alias: LLM_DEFAULT_MODEL_ALIAS, description: "平台默认模型" },
      ...rows.map((r) => ({ alias: r.alias, description: r.description })),
    ],
  });
});

/**
 * 客观题提交历史（本人；admin 可查他人）。
 * 注意：静态路径须在 /:id 之前注册（Hono 按注册顺序匹配参数路由）。
 * GET /api/v1/problems/submissions?paper_id=&contest_id=&user_id=&page=&per_page=
 */
router.get("/submissions", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const { page, perPage } = parsePagination(c, {
    defaultPerPage: 20,
    maxPerPage: 100,
  });

  const result = await listObjectiveSubmissionsCommand(
    userActorFromAuthenticatedId(userId),
    {
      paperId: c.req.query("paper_id") || undefined,
      contestId: c.req.query("contest_id") || undefined,
      targetUserId: c.req.query("user_id") || undefined,
      page,
      perPage,
    },
  );
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
  const data = await getObjectiveSubmissionCommand(
    userActorFromAuthenticatedId(userId),
    id,
  );
  return c.json({ data });
});

/**
 * 获取题目详情（双索引：UUID 或 display_id + 算法标签可视性门控，issue #223）。
 *
 * 算法标签仅 admin / 题主 / 有通过提交（finished 且 score>0）的 viewer 可见；
 * 其余 viewer 收不到算法标签名，仅收到 has_hidden_algorithm_tags 占位标志。
 *
 * 无权限一律 404（防存在性探测）。被关联到**尚未结束的公开赛**的题目同此口径：
 * 除 owner/管理员外一律 404，owner/管理员额外收到 `contest_secrecy` 提示字段。
 */
router.get("/:id", optionalAuthMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const userId = c.get("userId") as string | undefined;
  const isAdmin = userId ? await isCurrentUserAdmin(c) : false;

  // 统一题目访问解析：无权限一律 404，防存在性探测。
  const problem = await resolveProblem(id, { userId, isAdmin });
  const { result: access, secrecy } = await evaluateProblemAccess(problem, {
    viewerId: userId ?? null,
    isAdmin,
  });
  if (!access.allowed) {
    throw new NotFoundError("题目不存在");
  }

  const data = await applyAlgorithmTagVisibility(problem, { userId, isAdmin });

  // 保密提示：判定顺序保证能走到这里的非 owner/管理员不存在（上面已 404），
  // 因此该字段的实际读者只有 owner 与管理员。
  const secrecyNotice = secrecy.map((ref) => ({
    public_id: ref.publicId,
    title: ref.title,
  }));

  // 版本信息（Handbook §4.1）：默认作答版本（`exact` → 要求版本，`any` → 最新版）
  // 与最新版元数据。`?version_id=` 时按该版本内容回答（历史版本遵循同一访问权限，
  // 选择旧版不能绕过保密/竞赛封禁）。
  const [identity] = await getDb().select({
    latest_version_id: problems.latest_version_id,
    effective_version_mode: problems.effective_version_mode,
    required_version_id: problems.required_version_id,
    effective_policy_revision: problems.effective_policy_revision,
  }).from(problems).where(eq(problems.id, problem.id)).limit(1);

  const [binding] = await getDb().select().from(domainProblemBindings).where(
    and(
      eq(domainProblemBindings.problem_id, problem.id),
      eq(domainProblemBindings.domain_id, DEFAULT_DOMAIN_ID),
    ),
  );
  const policyIdentity = identity;
  const requestedVersionId = c.req.query("version_id")?.trim() || null;
  const canEdit = await canEditProblem(c, problem);
  if (!identity?.latest_version_id && !canEdit) {
    throw new NotFoundError("题目不存在");
  }
  let answerVersion: {
    version_id: string;
    version: number;
    content: ProblemContentV1;
    is_latest: boolean;
  } | null = null;
  if (requestedVersionId) {
    const row = await getProblemVersionOrThrow(problem.id, requestedVersionId);
    answerVersion = {
      version_id: row.id,
      version: row.version,
      content: row.content as ProblemContentV1,
      is_latest: identity?.latest_version_id === row.id,
    };
  } else {
    answerVersion = await resolveProblemAnswerVersion(problem.id);
  }

  const latestVersion =
    answerVersion?.version_id === identity?.latest_version_id
      ? answerVersion?.version ?? null
      : await resolveLatestVersionNumber(identity?.latest_version_id ?? null);

  // 内容与版本号必须来自**同一个已解析版本**（Handbook §4.1）：
  // 默认详情同样经过版本内容投影，避免"版本号 V1、题面/配置却是 V2"。
  // 敏感字段（评测配置、LLM、模板、支持包位置、客观题答案）由编辑者权限决定。
  const contentOverrides = answerVersion
    ? await buildVersionResponseOverrides(
      answerVersion.version_id,
      answerVersion.content,
      canEdit,
    )
    : {};

  const withVersion = {
    ...data,
    ...contentOverrides,
    version_id: answerVersion?.version_id ?? null,
    version: answerVersion?.version ?? null,
    latest_version_id: identity?.latest_version_id ?? null,
    latest_version: latestVersion,
    effective_version_policy: policyIdentity?.effective_version_mode === "exact"
      ? {
        mode: "exact" as const,
        version_id: policyIdentity.required_version_id,
      }
      : { mode: "any" as const },
    // 策略乐观锁版本（管理端切换策略时必须回传 `expected_revision`）。
    // 只是单调计数器，不含内容，对普通读者无敏感信息。
    effective_version_policy_revision: binding?.revision ??
      identity?.effective_policy_revision ?? 0,
    is_latest: answerVersion
      ? answerVersion.version_id === identity?.latest_version_id
      : false,
  };

  return c.json({
    data: secrecyNotice.length > 0
      ? { ...withVersion, contest_secrecy: secrecyNotice }
      : withVersion,
  });
});

/**
 * 版本内容 → 题目响应覆盖字段（含**该版本**的支持包存在性）。
 *
 * 支持包存在性必须按版本的文件引用解析：题目行投影是"最新版"口径，用它回答
 * 历史版本会出现"看 V1 却按 V2 报 has_support_package"。
 */
async function buildVersionResponseOverrides(
  versionId: string,
  content: ProblemContentV1,
  canEdit: boolean,
): Promise<Record<string, unknown>> {
  const overrides = projectProblemContent(content, canEdit);
  const supportPackageUrl = await getVersionSupportPackageUrl(versionId);
  overrides.has_support_package = supportPackageUrl !== null;
  if (canEdit) overrides.support_package_storage_url = supportPackageUrl;
  return overrides;
}

/** 读取版本号（用于 `latest_version`；缺失返回 null）。 */
async function resolveLatestVersionNumber(
  versionId: string | null,
): Promise<number | null> {
  if (!versionId) return null;
  const [row] = await getDb().select({ version: problemVersions.version })
    .from(problemVersions).where(eq(problemVersions.id, versionId)).limit(1);
  return row?.version ?? null;
}

/** 读取题目是否允许当前查看者编辑（用于内容裁剪，不在此处抛错）。 */
async function canEditProblem(
  c: Context<AuthEnv>,
  problem: { id: string; domain_id?: string | null; owner_id: string },
): Promise<boolean> {
  const userId = c.get("userId") as string | undefined;
  if (!userId) return false;
  try {
    await assertProblemEditPermissionForActor(
      problem,
      userActorFromAuthenticatedId(userId),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 题目读取权限：与详情接口同口径（无权限一律 404，防存在性探测）。
 *
 * 管理员用 `admin:full_access` 走 fast path；非管理员沿用统一访问解析，
 * 因此历史版本读取同样无法绕过竞赛保密。
 */
async function assertProblemReadable(
  c: Context<AuthEnv>,
  problem: Awaited<ReturnType<typeof resolveProblem>>,
): Promise<void> {
  const userId = c.get("userId") as string | undefined;
  const isAdmin = userId ? await isCurrentUserAdmin(c) : false;
  const { result: access } = await evaluateProblemAccess(problem, {
    viewerId: userId ?? null,
    isAdmin,
  });
  if (!access.allowed) {
    throw new NotFoundError("题目不存在");
  }
  // 未发布题目（尚无已发布版本）对普通访问者一律 404（Handbook §4.1）：
  // 编辑者改用草稿接口读取，避免把"草稿内容"当作公开题面下发。
  if (!isAdmin && !await isProblemPublished(problem.id)) {
    if (!await canEditProblem(c, problem)) {
      throw new NotFoundError("题目不存在");
    }
  }
}

/** 题目是否已有已发布版本（`problems.latest_version_id` 非空）。 */
async function isProblemPublished(problemId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ latest: problems.latest_version_id })
    .from(problems)
    .where(eq(problems.id, problemId))
    .limit(1);
  return row?.latest != null;
}

/**
 * 版本内容的权限裁剪：与题目详情**同一**按字段允许的公开响应
 * （{@link trimProblemContentForViewer}）——非编辑者不下发评测配置
 * （`runtime_config`：评测命令、镜像、网络权限、测试点路径）、LLM 配置、
 * 模板内容与客观题标准答案。
 */
function trimVersionContent(
  content: ProblemContentV1,
  canEdit: boolean,
): ProblemContentV1 {
  return trimProblemContentForViewer(content, canEdit);
}

/**
 * 读取共享草稿（编辑者）。
 *
 * 没有草稿行时返回基于最新版内容（其次题目投影）的编辑初值，`synthesized: true`。
 * 未发布题目对普通访问者不可见，但编辑者必须能通过本接口拿到初值。
 *
 * GET /api/v1/problems/:id/draft
 */
router.get("/:id/draft", authMiddleware, async (c) => {
  const problem = await resolveProblem(c.req.param("id") as string);
  await assertProblemEditPermissionForActor(
    problem,
    userActorFromAuthenticatedId(c.get("userId")),
  );
  const draft = await getProblemDraft(problem.id);
  return c.json({ data: draft });
});

/**
 * 发布预检（编辑者）：对**当前**草稿 revision 执行完整校验，不写库。
 *
 * GET /api/v1/problems/:id/draft/preflight
 */
router.get("/:id/draft/preflight", authMiddleware, async (c) => {
  const problem = await resolveProblem(c.req.param("id") as string);
  await assertProblemEditPermissionForActor(
    problem,
    userActorFromAuthenticatedId(c.get("userId")),
  );
  const report = await preflightProblemDraft(problem.id, {
    verifyObjects: c.req.query("verify") !== "false",
  });
  return c.json({ data: report });
});

/**
 * 版本元数据列表（分页，新→旧）。
 *
 * GET /api/v1/problems/:id/versions
 */
router.get("/:id/versions", optionalAuthMiddleware, async (c) => {
  const problem = await resolveProblem(c.req.param("id") as string);
  await assertProblemReadable(c, problem);
  const { page, perPage } = parsePagination(c);
  const versions = await listProblemVersions(problem.id, { page, perPage });
  return c.json({
    data: versions.data,
    total: versions.total,
    page,
    per_page: perPage,
  });
});

/**
 * 指定版本内容（经过权限裁剪）。
 *
 * 历史版本遵循题目**当前**访问权限与竞赛保密规则：选择旧版本不能绕过保密。
 * 非编辑者拿不到客观题标准答案与存储位置。
 *
 * GET /api/v1/problems/:id/versions/:versionId
 */
router.get("/:id/versions/:versionId", optionalAuthMiddleware, async (c) => {
  const problem = await resolveProblem(c.req.param("id") as string);
  const canEdit = await canEditProblem(c, problem);
  await assertProblemReadable(c, problem);
  const version = await getProblemVersionOrThrow(
    problem.id,
    c.req.param("versionId") as string,
  );
  const [identityRow] = await getDb().select({
    latest_version_id: problems.latest_version_id,
  }).from(problems).where(eq(problems.id, problem.id)).limit(1);
  return c.json({
    data: {
      version_id: version.id,
      version: version.version,
      origin: version.origin,
      change_note: version.change_note,
      published_at: version.published_at,
      is_latest: identityRow?.latest_version_id === version.id,
      content: trimVersionContent(
        version.content as ProblemContentV1,
        canEdit,
      ),
    },
  });
});

/**
 * 下载支持包。
 * GET /api/v1/problems/:id/support-package
 * 始终通过 noj-core 代理返回文件内容（S3/MinIO 可能位于内网）。
 */
router.get("/:id/support-package", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const userId = c.get("userId");
  const isAdmin = await isCurrentUserAdmin(c);

  const problem = await resolveProblem(id);
  // 公开赛保密：被加入未结束公开赛的题目对非 owner/管理员按"不存在"处理（404），
  // 否则"403 无包权限"与"404 不存在"的差异会暴露该题目的存在。
  //
  // 这里**只**拦保密命中，不改动既有的包权限口径：私有题的 403 由
  // `getSupportPackageBytes` 的 package_manage_own/_any 校验给出，属于另一套
  // 基于角色的控制，不在本次规则范围内。
  const { result: access } = await evaluateProblemAccess(problem, {
    viewerId: userId,
    isAdmin,
  });
  if (access.mode === "contest-secret") {
    throw new NotFoundError("题目不存在");
  }
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
 * 用于编辑器在没有用户本地草稿时填入的初始代码。解析顺序见
 * `resolveProblemTemplate`：导入时从题包持久化的内容 → 已存储支持包内的模板 →
 * 本地源码目录（仅开发环境有效）。
 *
 * 模板来源曾经只有"服务器本地 `data/problems-src`"，容器化生产既没有私有题源、
 * manifest 又普遍不写 number，导致线上所有题目的模板恒 404（编辑器空白且无提示）。
 *
 * 模板仅供前端编辑器初始填充（starter code），与评测参考实现解耦；
 * 不再回退 submission_sample.py / submission.py。
 *
 * 可见性与题目详情同口径（此前本 handler **完全没有访问校验**，私有题的模板对任意
 * 登录用户可读）。竞赛编辑器改用域竞赛模板端点
 * `/api/v1/domains/:slug/contests/:id/problems/:label/template`，本端点不再接受 `?contest_id=`。
 */
router.get("/:id/template", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const userId = c.get("userId") as string;
  const isAdmin = await isCurrentUserAdmin(c);
  const problem = await resolveProblem(id);
  const { result } = await evaluateProblemAccess(problem, {
    viewerId: userId,
    isAdmin,
  });
  if (!result.allowed) {
    throw new NotFoundError("题目不存在");
  }
  // 界面题的脚本模板是出题人的评测逻辑，选手只通过 ui.html 填参数，不下发模板
  if (problem.submission_mode === "ui") {
    return c.json({ error: "该题目没有初始代码模板" }, 404);
  }
  const requestedTemplateVersionId = c.req.query("version_id")?.trim() || null;
  const tpl = await resolveProblemTemplate({
    id: problem.id,
    number: problem.number,
    title: problem.title,
  }, {
    // 模板必须与作答版本一致（Handbook §4.1）：显式 `?version_id=` 优先，
    // 否则取默认作答版本（exact → 要求版本、any → 最新版），绝不无条件取最新版。
    versionId: requestedTemplateVersionId ??
      (await resolveProblemAnswerVersion(problem.id))?.version_id ?? null,
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

// ── 客观题（并入 problems 体系，is_objective 标记）───────────────────────────

/**
 * 获取客观题套卷小题列表。
 * GET /api/v1/problems/:id/questions?contest_id=&version_id=
 *
 * 编辑者（owner/admin）读**共享草稿**含答案与解析；其余读**作答版本**快照并裁剪
 * 答案（Handbook §6.4）。作答版本：竞赛 → 该竞赛**固定版本**；否则显式
 * `?version_id=`；再否则题库默认作答版本（`exact` → 要求版本、`any` → 最新版）。
 * 响应回传实际版本号，客户端须用它提交（竞赛里不一致将
 * `409 CONTEST_PROBLEM_VERSION_CHANGED`）。未发布套卷对非编辑者 404。
 */
router.get("/:id/questions", optionalAuthMiddleware, async (c) => {
  const paperId = (await resolveProblem(c.req.param("id") as string)).id;
  const userId = c.get("userId") as string | undefined;

  // 套卷也走统一题目访问解析：private 套卷非 owner/admin 一律 404；
  // 竞赛页可携带 contest_id 传入竞赛上下文放行。
  // 竞赛上下文校验收敛在 objective 域服务内，catalog 域不反向依赖 contest 域。
  const viewerId = userId ?? null;
  const isAdmin = userId ? await isCurrentUserAdmin(c) : false;
  const contestId = c.req.query("contest_id");
  const result = await listPaperQuestionsWithAccess(paperId, {
    viewerId,
    isAdmin,
    contestId,
    versionId: c.req.query("version_id"),
  });
  return c.json({
    data: result.questions,
    version_id: result.version_id,
    version: result.version,
  });
});

export default router;
