/**
 * Problems CRUD：createProblem / updateProblem / deleteProblem（PR 拆分 PR-3）。
 *
 * 设计要点：
 * - 创建题目、初始草稿、标签、本域绑定及编号同事务
 * - updateProblem 拒绝已撤除的分类，题号保持不可变
 * - deleteProblem 手动清理 submissions / evaluation_results（FK 无 CASCADE）
 *
 * 依赖：
 * - validateRuntimeConfig / types.ts：DTO 与 runtime 校验
 * - syncProblemTags / problems-tags.ts：标签关联维护（issue #223）
 * - getProblem / problems-list.ts：回读完整结果（避免与上面产生 init 顺序循环）
 *   —— getProblem 是函数级引用，运行时才解析，无循环问题
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import { recordProblemEducationChange } from "../workspace/education-events.ts";
import {
  contestProblems,
  domainProblemBindings,
  domainResourceCounters,
  domains,
  objectiveSubmissions,
  problemBindingHistory,
  problemDraftObjects,
  problemDrafts,
  problems,
  problemTags,
  problemVersionObjects,
  problemVersions,
  selfTests,
  submissions,
} from "./../../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "./../../../../shared/base/errors.ts";
import {
  deleteStorageObject,
  getStorageProvider,
} from "./../../../system/index.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "catalog"]);
import { validateJudgeImageWithKind } from "../../../system/index.ts";
import { logAudit } from "../../../system/index.ts";
import { assertLlmLimitsWithinDefault } from "../../../gateway/index.ts";
import {
  type CreateProblemInput,
  DIFFICULTIES,
  isOiRuntimeConfig,
  isValidDifficulty,
  isValidLlmConfig,
  isValidSubmissionMode,
  judgeTypeForRuntimeConfig,
  type LlmConfig,
  type ProblemResponseWithTags,
  type ProblemRuntimeConfig,
  type UpdateProblemInput,
} from "./../../types/problems.ts";
import { validateProblemRuntimeConfig } from "./problems-types.ts";
import { syncProblemTags, validateProblemTagIds } from "./problems-tags.ts";
import { getProblem } from "./problems-list.ts";
import { publishSearchIndexEvent } from "./../../../../shared/search-events.ts";

import {
  assertSensitiveFieldPermissions,
  enforceResourceLimits,
} from "./problem-field-guard.ts";
import type { Context } from "hono";
import { ROOT_USER_ID } from "./../../../../shared/base/constants.ts";
import { validateProblemSamples } from "../../types/problem-samples.ts";
import {
  deriveDraftContentFromProblem,
  type DraftObjectRef,
  draftRevisionRequired,
  getProblemDraft,
  PROBLEM_DRAFT_VIRTUAL_REVISION,
  type ProblemDraftView,
  saveProblemDraft,
  saveProblemDraftWithObjects,
  setDraftObject,
} from "../versioning/draft.ts";
import {
  type ProblemContentKind,
  problemContentKindOf,
  type ProblemContentV1,
  type ProblemDraftContent,
} from "../../types/problem-content.ts";
import type { RuntimeConfig } from "../../types/runtime-config.ts";
import {
  bumpProjectionRevision,
  globalScopeKey,
  problemScopeKey,
} from "../../../submission/index.ts";
import { registerLegacyStorageObject } from "./../../../system/index.ts";
import { assertProblemHasNoRetainedReferences } from "../workspace/problem-retention.ts";
import { assertProblemAuthoringOutsideParticipation } from "../workspace/problem-contest-authoring.ts";
import {
  bindCreatedDomainProblem,
  prepareDomainProblemCreation,
} from "../workspace/problem-create.ts";
import {
  assertWorkspacePermission,
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
  ensureDefaultWorkspace,
  loadWorkspace,
  workspaceAudit,
} from "../../../workspace/index.ts";

/**
 * 题目内容编辑权限（唯一判定入口）。
 *
 * 草稿读写、发布版本与既有 PUT 内容更新共用同一口径，避免"草稿接口是旁路"：
 * - 本域编辑者编辑本人资源需 `problem:write_own`；
 * - 编辑其他资源需源域 `problem:write_any`，平台治理使用真实实例权限。
 *
 * 平台治理例外取自实时实例权限。
 *
 * @throws {ForbiddenError} 权限不足
 */
export async function assertProblemEditPermission(
  c: Context | undefined,
  problem: { id: string; domain_id?: string | null; owner_id: string },
  userId?: string,
  _userRole?: string,
): Promise<void> {
  const actorId = c?.var.userId ?? userId ?? ROOT_USER_ID;
  const db = getDb();
  const [source] = await db.select().from(problems).where(
    eq(problems.id, problem.id),
  );
  if (!source) throw new NotFoundError("题目不存在");
  const [domain] = source.domain_id
    ? await db.select({ slug: domains.slug }).from(domains).where(
      eq(domains.id, source.domain_id),
    )
    : [{ slug: DEFAULT_DOMAIN_SLUG }];
  if (!domain) throw new NotFoundError("源题工作空间不存在");
  const workspace = await loadWorkspace(domain.slug, actorId, {
    write: c !== undefined && !["GET", "HEAD"].includes(c.req.method),
  });
  assertWorkspacePermission(
    workspace.context,
    workspace.context.domainPermissions.has("problem:write_any") ||
      source.owner_id !== actorId
      ? "problem:write_any"
      : "problem:write_own",
  );
  await assertProblemAuthoringOutsideParticipation(workspace, source.id, db);
}

/**
 * 创建题目。
 *
 * 源域角色决定创建权限，旧无域入口只创建默认域资源。
 * 自动设 owner_id 为当前用户，域行锁原子分配数字题号。
 *
 * @throws {BadRequestError} 难度值非法
 * @throws {ForbiddenError} 当前域角色无创建权限
 */
export async function createProblem(
  input: CreateProblemInput,
  userId?: string,
  userRole?: string,
  c?: Context,
  allowServerDerivedFields = false,
  workspaceSlug?: string,
  initialDraft?: { content: ProblemDraftContent; objects: DraftObjectRef[] },
): Promise<ProblemResponseWithTags> {
  const db = getDb();
  if (input.samples !== undefined) validateProblemSamples(input.samples);

  // NOJ-115/116：服务端流程（import-bundle）以外禁止客户端直传存储 URL。
  if (
    input.support_package_storage_url !== undefined &&
    input.support_package_storage_url !== null &&
    !allowServerDerivedFields
  ) {
    throw new BadRequestError(
      "support_package_storage_url 仅允许由服务端支持包上传/导入流程生成",
    );
  }

  // 校验难度
  if (input.difficulty && !isValidDifficulty(input.difficulty)) {
    throw new BadRequestError(
      `非法难度值：${input.difficulty}，仅允许 ${DIFFICULTIES.join("/")}`,
    );
  }

  // 校验提交模式
  const submissionMode = input.submission_mode ?? "code";
  if (!isValidSubmissionMode(submissionMode)) {
    throw new BadRequestError(
      `非法提交模式：${input.submission_mode}，仅允许 code / artifact`,
    );
  }

  // 校验 artifact 大小上限
  if (
    input.artifact_max_size_mb !== undefined &&
    input.artifact_max_size_mb !== null &&
    (!Number.isInteger(input.artifact_max_size_mb) ||
      input.artifact_max_size_mb <= 0)
  ) {
    throw new BadRequestError("artifact_max_size_mb 必须为正整数或 null");
  }

  if ("type" in input) {
    throw new BadRequestError("题目已取消 P/U 分类，请通过目标 Domain 创建");
  }
  if (
    input.visibility !== undefined &&
    !["public", "private"].includes(input.visibility)
  ) throw new BadRequestError("visibility 必须为 public/private");

  // 客观题标记（统一题库；无评测容器，服务端即时判定）
  const isObjective = input.is_objective === true;

  // 校验 runtime_config（编程题必填，双容器评测；客观题套卷无评测容器）
  if (isObjective) {
    if (input.runtime_config !== undefined && input.runtime_config !== null) {
      logger.warn("createProblem: 客观题套卷忽略 runtime_config 字段");
    }
  } else if (
    input.runtime_config !== undefined && input.runtime_config !== null
  ) {
    validateProblemRuntimeConfig(input.runtime_config);
    if (
      input.judge_type !== undefined &&
      input.judge_type !== judgeTypeForRuntimeConfig(input.runtime_config)
    ) {
      throw new BadRequestError(
        "judge_type 必须与 runtime_config 的评测模式一致",
      );
    }
    if (
      isOiRuntimeConfig(input.runtime_config) &&
      (input.submission_mode === "artifact" ||
        (input.artifact_max_size_mb !== undefined &&
          input.artifact_max_size_mb !== null))
    ) {
      throw new BadRequestError("OI 题仅支持 code 提交，不支持 artifact 配置");
    }
    if (!isOiRuntimeConfig(input.runtime_config)) {
      try {
        await validateJudgeImageWithKind(
          input.runtime_config.evaluator.image,
          "evaluator",
        );
        await validateJudgeImageWithKind(
          input.runtime_config.solution.image,
          "solution",
        );
      } catch (err) {
        logger.error("createProblem: runtime_config 镜像校验失败", { err });
        throw err;
      }
    }

    // 安全提醒：联网 + 可控 evaluator.command = 联网容器任意命令执行，
    // 开启联网的题目等于把外部网络能力交给出题人（出题人可信边界）。
    // 复用平台默认值基线；OI 不含双容器敏感字段。
    await assertSensitiveFieldPermissions(
      c,
      userId,
      userRole,
      input.runtime_config,
    );
    enforceResourceLimits(input.runtime_config);
  } else {
    logger.error("createProblem: runtime_config 缺失", {
      input: JSON.stringify(input),
    });
    throw new BadRequestError("runtime_config 是必填字段");
  }

  // LLM 能力与旧题库分类无关，预算和 evaluator 网络仍受实例安全政策约束。
  let llmConfig: LlmConfig | null = null;
  if (input.llm !== undefined && input.llm !== null) {
    if (isObjective) {
      throw new BadRequestError("客观题套卷不支持 LLM 配置");
    }
    if (!isValidLlmConfig(input.llm)) {
      throw new BadRequestError("llm 配置格式非法");
    }
    assertLlmLimitsWithinDefault(input.llm);
    const runtime = input.runtime_config;
    if (
      !runtime || isOiRuntimeConfig(runtime) ||
      !runtime.evaluator.network?.enabled
    ) {
      throw new BadRequestError("启用 LLM 必须开启 evaluator 网络");
    }
    llmConfig = input.llm;
  }

  // 题目主键统一由服务端生成 UUID，避免客户端注入字符串 id
  // 影响 display_id 双索引路由解析
  const id = crypto.randomUUID();

  const ownerId = userId ?? ROOT_USER_ID;
  if (!workspaceSlug) {
    const [defaultDomain] = await db.select({ id: domains.id }).from(domains)
      .where(eq(domains.slug, DEFAULT_DOMAIN_SLUG));
    if (!defaultDomain) await ensureDefaultWorkspace();
  }
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    const reservation = await prepareDomainProblemCreation(
      workspaceSlug ?? DEFAULT_DOMAIN_SLUG,
      ownerId,
      input.number,
      tx,
    );
    const [created] = await tx.insert(problems).values({
      id,
      title: input.title,
      description: input.description,
      samples: input.samples ?? [],
      difficulty: input.difficulty ?? "medium",
      support_package_storage_url: input.support_package_storage_url ??
        null,
      runtime_config: isObjective ? null : (input.runtime_config ?? null),
      judge_type: isObjective
        ? "dual"
        : judgeTypeForRuntimeConfig(input.runtime_config),
      is_objective: isObjective,
      visibility: input.visibility ??
        (workspaceSlug && workspaceSlug !== DEFAULT_DOMAIN_SLUG
          ? "private"
          : "public"),
      submission_mode: submissionMode,
      artifact_max_size_mb: input.artifact_max_size_mb ?? null,
      llm_config: llmConfig,
      number: reservation.number,
      domain_id: reservation.domain.id,
      owner_id: ownerId,
      created_at: now,
      updated_at: now,
    }).returning();
    const draftInput = {
      content: initialDraft?.content ?? deriveDraftContentFromProblem(created),
      expectedRevision: PROBLEM_DRAFT_VIRTUAL_REVISION,
      actorId: ownerId,
      context: c,
    };
    if (initialDraft) {
      await saveProblemDraftWithObjects(id, {
        ...draftInput,
        objects: initialDraft.objects,
      }, tx);
    } else {
      await saveProblemDraft(id, draftInput, tx);
    }
    if (input.tag_ids?.length) {
      await syncProblemTags(id, input.tag_ids, isObjective, tx);
    }
    await bindCreatedDomainProblem(
      created,
      reservation.domain.id,
      ownerId,
      reservation.used,
      tx,
    );
  });

  // 服务端派生支持包（题包导入）：登记对象并写入**草稿**文件引用，发布时随版本固定
  if (input.support_package_storage_url) {
    try {
      await registerLegacyStorageObject(input.support_package_storage_url);
      await setDraftObject(id, {
        role: "support_package",
        path: "package.zip",
        storage_url: input.support_package_storage_url,
      });
    } catch (err) {
      logger.error("createProblem: 支持包对象登记失败", {
        id,
        storage_url: input.support_package_storage_url,
        err,
      });
    }
  }

  await publishSearchIndexEvent("problem", id, "upsert");

  return getProblem(id);
}

/** 显式使用域创建源题；复用运行配置校验、共享草稿和不可变版本流程。 */
export function createDomainProblem(
  slug: string,
  input: CreateProblemInput,
  actorId: string,
  context?: Context,
  initialDraft?: { content: ProblemDraftContent; objects: DraftObjectRef[] },
) {
  return createProblem(
    input,
    actorId,
    undefined,
    context,
    false,
    slug,
    initialDraft,
  );
}

/**
 * 把内容补丁合并进草稿内容（Handbook §2.3「内容字段只由发布服务写入投影」）。
 *
 * - `kind` 由目标题型决定（objective / oi / ai），补丁里没有的字段沿用草稿现值，
 *   草稿缺失时回退题目投影；
 * - 客观题小题不接受客户端任意注入：转为客观题时保留草稿内既有小题（旧
 *   `objective_questions` 表已删除，小题由客观题编辑接口写入草稿）；
 * - 题型专属字段按目标 kind 归一，避免 AI 字段残留在 OI 内容里。
 *
 * @throws {BadRequestError} 缺少目标类别必需的配置
 */
export async function mergeProblemContentPatch(
  problem: typeof problems.$inferSelect,
  current: ProblemDraftContent,
  kind: ProblemContentKind,
  patch: Record<string, unknown>,
): Promise<ProblemDraftContent> {
  const base = {
    kind,
    title: (patch.title ??
      current.title ?? problem.title) as string,
    description: (patch.description ??
      current.description ?? problem.description) as string,
    samples: (patch.samples ??
      current.samples ?? []) as ProblemDraftContent["samples"],
  };

  if (kind === "objective") {
    const existing = (current as { questions?: unknown }).questions;
    const questions = Array.isArray(existing) && current.kind === "objective"
      ? existing
      : ((await deriveDraftContentFromProblem({
        ...problem,
        is_objective: true,
        judge_type: "dual",
      })) as { questions?: unknown }).questions ?? [];
    return { ...base, questions };
  }

  const read = (key: string, fallback: unknown) =>
    patch[key] ?? (current as Record<string, unknown>)[key] ?? fallback;
  const runtimeConfig = read("runtime_config", problem.runtime_config);

  // 草稿允许暂时不完整（Handbook §2.4）：缺失运行配置不在这里报错，
  // 由发布预检（preflightProblemDraft）判定是否可发布。
  if (kind === "oi") {
    return { ...base, runtime_config: runtimeConfig };
  }

  return {
    ...base,
    submission_mode: read("submission_mode", problem.submission_mode),
    runtime_config: runtimeConfig,
    template_content: read("template_content", problem.template_content ?? ""),
    artifact_max_size_mb: read(
      "artifact_max_size_mb",
      problem.artifact_max_size_mb,
    ),
    llm_config: read("llm_config", problem.llm_config),
  };
}

/**
 * 全量更新题目。
 *
 * 权限规则：
 * - admin 可更新任意题目
 * - 编辑本人资源与全域资源使用源域角色能力
 * - 拒绝旧分类字段，题号创建后固定
 *
 * 内容与管理的分工（Handbook §2.3/§6.2）：
 * - **内容**（题面、评测配置、模板、LLM、客观题小题）写入共享草稿；已发布题目的
 *   投影只由发布服务更新，本次调用不改变公开内容；
 * - **管理信息**（难度、可见性、标签）与题型（kind）继续直接维护在题目行；
 * - 迁移期例外：**尚未发布**的题目没有版本，投影仍是唯一读取面（题库列表、
 *   编辑器初值），此时内容同时写入投影，避免"保存成功但刷新后消失"。
 *
 * @throws {NotFoundError} 题目不存在
 * @throws {BadRequestError} 难度值非法
 * @throws {ForbiddenError} 权限不足
 */
export async function updateProblem(
  id: string,
  input: UpdateProblemInput,
  userId?: string,
  userRole?: string,
  c?: Context,
  allowServerDerivedFields = false,
  expectedUpdatedAt?: string,
): Promise<ProblemResponseWithTags> {
  const db = getDb();

  // NOJ-115/116：服务端流程（import-bundle）以外禁止客户端直传存储 URL。
  if (
    input.support_package_storage_url !== undefined &&
    input.support_package_storage_url !== null &&
    !allowServerDerivedFields
  ) {
    throw new BadRequestError(
      "support_package_storage_url 仅允许由服务端支持包上传/导入流程生成",
    );
  }

  // 模板内容由导入流程从题包内派生（manifest.template，缺省 template.py），
  // 与存储 URL 同一性质：客户端直传等于绕过题包往库里塞任意 starter code。
  if (
    input.template_content !== undefined &&
    input.template_content !== null &&
    !allowServerDerivedFields
  ) {
    throw new BadRequestError(
      "template_content 仅允许由服务端题目包导入流程写入",
    );
  }

  const existing = await db
    .select()
    .from(problems)
    .where(eq(problems.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("题目不存在");
  }

  const problem = existing[0];
  if (input.visibility !== undefined) {
    if (!["public", "private"].includes(input.visibility)) {
      throw new BadRequestError("visibility 必须为 public/private");
    }
  }

  await assertProblemEditPermission(c, problem, userId, userRole);
  const [sourceDomain] = await db.select({ slug: domains.slug }).from(domains)
    .where(eq(domains.id, problem.domain_id ?? DEFAULT_DOMAIN_ID));
  await loadWorkspace(
    sourceDomain.slug,
    c?.var.userId ?? userId ?? ROOT_USER_ID,
    { write: true },
  );

  // 内容事实源：已发布题目的草稿（可能领先投影），未发布题目回退投影。
  // 校验基线统一取草稿，避免用"最新版投影"判断"敏感字段是否被改动"而误拒/误放。
  const problemDraft: ProblemDraftView = await getProblemDraft(id, problem);
  const draftRuntime = (problemDraft.content as { runtime_config?: unknown })
    .runtime_config;
  const baselineRuntime = (draftRuntime ?? problem.runtime_config) as
    | ProblemRuntimeConfig
    | null;
  const hasPublishedVersion = problem.latest_version_id !== null;

  // 校验难度
  if (input.difficulty && !isValidDifficulty(input.difficulty)) {
    throw new BadRequestError(
      `非法难度值：${input.difficulty}，仅允许 ${DIFFICULTIES.join("/")}`,
    );
  }

  // 校验提交模式
  if (
    input.submission_mode !== undefined &&
    !isValidSubmissionMode(input.submission_mode)
  ) {
    throw new BadRequestError(
      `非法提交模式：${input.submission_mode}，仅允许 code / artifact`,
    );
  }

  // 校验 artifact 大小上限
  if (
    input.artifact_max_size_mb !== undefined &&
    input.artifact_max_size_mb !== null &&
    (!Number.isInteger(input.artifact_max_size_mb) ||
      input.artifact_max_size_mb <= 0)
  ) {
    throw new BadRequestError("artifact_max_size_mb 必须为正整数或 null");
  }

  // 校验 runtime_config
  //   undefined → 不变；null → 拒绝（编程题 runtime_config 是必填字段）；object → 校验并写入
  //   客观题套卷（is_objective）：忽略 runtime_config（无评测容器）
  const isObjective = input.is_objective ?? problem.is_objective;
  if (input.judge_type !== undefined) {
    if (isObjective) {
      if (input.judge_type !== "dual") {
        throw new BadRequestError("客观题套卷仅允许 judge_type=dual");
      }
    } else {
      const effectiveRuntime = input.runtime_config ?? baselineRuntime;
      if (
        !effectiveRuntime ||
        input.judge_type !== judgeTypeForRuntimeConfig(effectiveRuntime)
      ) {
        throw new BadRequestError(
          "judge_type 必须与 runtime_config 的评测模式一致",
        );
      }
    }
  }
  if (!isObjective && input.runtime_config !== undefined) {
    if (input.runtime_config === null) {
      throw new BadRequestError("runtime_config 是必填字段，不可清空");
    }
    validateProblemRuntimeConfig(input.runtime_config);
    if (
      isOiRuntimeConfig(input.runtime_config) &&
      (input.submission_mode === "artifact" ||
        (input.artifact_max_size_mb !== undefined &&
          input.artifact_max_size_mb !== null))
    ) {
      throw new BadRequestError("OI 题仅支持 code 提交，不支持 artifact 配置");
    }
    if (!isOiRuntimeConfig(input.runtime_config)) {
      await validateJudgeImageWithKind(
        input.runtime_config.evaluator.image,
        "evaluator",
      );
      await validateJudgeImageWithKind(
        input.runtime_config.solution.image,
        "solution",
      );
    }

    // 更新以库中已有配置为基线，未修改的敏感字段不重复要求权限。
    await assertSensitiveFieldPermissions(
      c,
      userId,
      userRole,
      input.runtime_config,
      baselineRuntime,
    );
    enforceResourceLimits(input.runtime_config);
  }
  const effectiveRuntimeForSubmission = (input.runtime_config ??
    baselineRuntime) as ProblemRuntimeConfig | null;
  if (
    !isObjective && isOiRuntimeConfig(effectiveRuntimeForSubmission) &&
    (input.submission_mode === "artifact" ||
      (input.artifact_max_size_mb !== undefined &&
        input.artifact_max_size_mb !== null))
  ) {
    throw new BadRequestError("OI 题仅支持 code 提交，不支持 artifact 配置");
  }

  // LLM 配置变更仍校验预算和 evaluator 网络，不按旧 P/U 分类授权。
  let llmConfig: LlmConfig | null | undefined;
  if (input.llm !== undefined) {
    if (input.llm === null) {
      llmConfig = null;
    } else {
      if (!isValidLlmConfig(input.llm)) {
        throw new BadRequestError("llm 配置格式非法");
      }
      if (isObjective) {
        throw new BadRequestError("客观题套卷不支持 LLM 配置");
      }
      assertLlmLimitsWithinDefault(input.llm);
      const effectiveRuntime = input.runtime_config ?? baselineRuntime;
      if (
        !effectiveRuntime || isOiRuntimeConfig(effectiveRuntime) ||
        !effectiveRuntime.evaluator.network?.enabled
      ) {
        throw new BadRequestError("启用 LLM 必须开启 evaluator 网络");
      }
      llmConfig = input.llm;
    }
  }

  // 若题目已有/仍有 LLM 配置，必须保持 evaluator 网络开启；改为客观题时自动清空。
  const existingLlm = problem.llm_config as LlmConfig | null;
  const nextLlm = llmConfig !== undefined ? llmConfig : existingLlm;
  if (nextLlm) {
    if (isObjective) {
      llmConfig = null;
    } else if (
      input.runtime_config !== undefined &&
      input.runtime_config !== null &&
      !isOiRuntimeConfig(input.runtime_config) &&
      !input.runtime_config.evaluator.network?.enabled
    ) {
      throw new BadRequestError("启用 LLM 的题目必须保持 evaluator 网络开启");
    }
  }

  if ("type" in input) throw new BadRequestError("题目已取消 P/U 分类");
  // 数字题号创建后固定，不影响不可变版本。
  delete (input as Record<string, unknown>)["number"];

  // ── 首次发布后固定题型与提交模式（Handbook §2.3）─────────────────────────
  // 题目内容类别（objective / oi / ai）与 AI 的 submission_mode 由题目身份承载，
  // 一旦有已发布版本就不可再改：跨类型转换必须新建题目。否则题目行会与最新版
  // 内容不一致（行说客观题、版本内容是 AI），提交路径会按错的题型执行。
  if (hasPublishedVersion) {
    const publishedKind = problemContentKindOf(problem);
    const requestedKind = input.is_objective === true
      ? "objective"
      : ((input.runtime_config !== undefined || input.judge_type !== undefined)
        ? (input.judge_type === "oi" ||
            (input.runtime_config != null &&
              isOiRuntimeConfig(input.runtime_config as RuntimeConfig))
          ? "oi"
          : "ai")
        : publishedKind);
    if (requestedKind !== publishedKind) {
      throw new AppError(
        `题目题型在首次发布后不可变更（当前 ${publishedKind}，请求 ${requestedKind}）；跨题型转换请新建题目`,
        409,
        "CONTENT_KIND_IMMUTABLE",
      );
    }
    if (
      publishedKind === "ai" &&
      input.submission_mode !== undefined &&
      input.submission_mode !== problem.submission_mode
    ) {
      throw new AppError(
        `AI 题提交模式在首次发布后不可变更（当前 ${problem.submission_mode}）；请新建题目`,
        409,
        "CONTENT_KIND_IMMUTABLE",
      );
    }
  }

  // ── 管理信息（题目身份）：难度、可见性、题型、服务端派生引用 ─────────────
  const updates: Record<string, unknown> = {};
  if (input.visibility !== undefined) updates.visibility = input.visibility;
  if (input.oi_data_files !== undefined) {
    if (!allowServerDerivedFields) {
      throw new BadRequestError("OI 文件引用只能由数据编辑服务生成");
    }
    updates.oi_data_files = input.oi_data_files;
  }
  if (input.difficulty !== undefined) updates.difficulty = input.difficulty;
  if (input.support_package_storage_url !== undefined) {
    updates.support_package_storage_url = input.support_package_storage_url;
  }
  // 客观题标记变更（由客观题改回编程题时必须同时提供 runtime_config）
  if (
    input.is_objective !== undefined &&
    input.is_objective !== problem.is_objective
  ) {
    updates.is_objective = input.is_objective;
    if (!input.is_objective && input.runtime_config === undefined) {
      throw new BadRequestError(
        "由客观题改为编程题时，必须提供 runtime_config",
      );
    }
  }
  if (isObjective) {
    // 客观题套卷没有评测容器；切换类型时也要清理旧的运行配置，避免
    // 题目列标记为 objective/dual 而残留一份可执行的 OI 或双容器配置。
    updates.runtime_config = null;
    updates.template_content = null;
    // 客观题没有 OI/双容器执行器；无论原题模式为何，数据库列也必须归一为 dual。
    updates.judge_type = "dual";
  } else if (input.runtime_config !== undefined) {
    updates.judge_type = judgeTypeForRuntimeConfig(input.runtime_config);
  }

  // 目标内容类别（kind 属于题目身份：决定草稿允许的类别与发布期望类别）
  const nextKind: ProblemContentKind = isObjective
    ? "objective"
    : ((updates.judge_type as string | undefined) ?? problem.judge_type) ===
        "oi"
    ? "oi"
    : "ai";

  // ── 内容补丁：题面、评测配置、模板、LLM ─────────────────────────────────
  const contentPatch: Record<string, unknown> = {};
  if (input.title !== undefined) contentPatch.title = input.title;
  if (input.description !== undefined) {
    contentPatch.description = input.description;
  }
  if (input.samples !== undefined) {
    validateProblemSamples(input.samples);
    contentPatch.samples = input.samples;
  }
  if (!isObjective && input.runtime_config !== undefined) {
    contentPatch.runtime_config = input.runtime_config;
    if (isOiRuntimeConfig(input.runtime_config)) {
      // OI runner 只接受源码提交；切换模式时清理存量 artifact 配置。
      contentPatch.submission_mode = "code";
      contentPatch.artifact_max_size_mb = null;
    }
  }
  if (llmConfig !== undefined) contentPatch.llm_config = llmConfig;
  if (!isObjective && input.submission_mode !== undefined) {
    contentPatch.submission_mode = input.submission_mode;
  }
  if (!isObjective && input.artifact_max_size_mb !== undefined) {
    contentPatch.artifact_max_size_mb = input.artifact_max_size_mb;
  }
  // 模板：仅导入流程可写；转为客观题套卷时必须清空（套卷没有参赛代码）。
  if (!isObjective && input.template_content !== undefined) {
    contentPatch.template_content = input.template_content;
  }

  const hasContentChange = Object.keys(contentPatch).length > 0 ||
    nextKind !== problemDraft.content.kind;
  let nextContent: ProblemContentV1 | null = null;
  if (hasContentChange) {
    nextContent = await mergeProblemContentPatch(
      problem,
      problemDraft.content,
      nextKind,
      contentPatch,
    ) as unknown as ProblemContentV1;
  }

  // 半写入防护：标签校验（存在性 + 客观题 kind 规则）在字段提交之前完成，
  // 校验失败（400）不产生「客户端以为未改、实际已改」的半写入。
  const validatedTagIds = input.tag_ids === undefined
    ? undefined
    : await validateProblemTagIds(input.tag_ids, isObjective);

  const hasDerivedPackage = allowServerDerivedFields &&
    !!input.support_package_storage_url;
  let expectedRevision = problemDraft.revision;
  if (c && (hasContentChange || hasDerivedPackage)) {
    const header = c.req.header("if-match");
    const raw = header === undefined
      ? input.expected_revision
      : Number(header.replace(/^"|"$/g, ""));
    if (raw == null) throw draftRevisionRequired();
    if (!Number.isInteger(raw) || raw < 0) {
      throw new BadRequestError("预期 revision 必须是非负整数");
    }
    expectedRevision = raw;
  }
  if (
    Object.keys(updates).length > 0 || validatedTagIds !== undefined ||
    hasContentChange || hasDerivedPackage
  ) {
    updates.updated_at = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM problems WHERE id = ${id} FOR UPDATE`,
      );
      const applied = await tx.update(problems).set(updates).where(
        expectedUpdatedAt === undefined ? eq(problems.id, id) : and(
          eq(problems.id, id),
          eq(problems.updated_at, expectedUpdatedAt),
        ),
      ).returning({ id: problems.id });
      if (applied.length === 0) {
        throw new ConflictError("题目已被修改，请重新加载后保存");
      }
      if (
        input.visibility !== undefined &&
        input.visibility !== problem.visibility
      ) {
        const changedBindings = await tx.update(domainProblemBindings).set({
          visibility: input.visibility === "public" ? "public" : "members",
          revision: sql`${domainProblemBindings.revision} + 1`,
          updated_at: new Date().toISOString(),
        }).where(and(
          eq(domainProblemBindings.problem_id, id),
          eq(
            domainProblemBindings.domain_id,
            problem.domain_id ?? DEFAULT_DOMAIN_ID,
          ),
          eq(domainProblemBindings.kind, "owned"),
        )).returning();
        const actorId = c?.var.userId ?? userId ?? ROOT_USER_ID;
        for (const binding of changedBindings) {
          const reason = `修改本域源题展示范围：${binding.visibility}`;
          await tx.insert(problemBindingHistory).values({
            id: crypto.randomUUID(),
            binding_id: binding.id,
            problem_id: id,
            revision: binding.revision,
            effective_version_mode: binding.effective_version_mode,
            required_version_id: binding.required_version_id,
            answer_version_id: binding.required_version_id ??
              problem.latest_version_id,
            disabled_at: binding.disabled_at,
            actor_id: actorId,
            reason,
            created_at: binding.updated_at,
          });
          await workspaceAudit(
            tx,
            actorId,
            binding.domain_id,
            "domain.update",
            {
              operation: "problem.binding",
              binding_id: binding.id,
              problem_id: id,
              revision: binding.revision,
              reason,
              visibility: binding.visibility,
              disabled_at: binding.disabled_at,
            },
          );
        }
        await recordProblemEducationChange(tx, id);
      }
      if (validatedTagIds !== undefined) {
        await tx.delete(problemTags).where(eq(problemTags.problem_id, id));
        if (validatedTagIds.length > 0) {
          await tx.insert(problemTags).values(
            validatedTagIds.map((tagId) => ({ problem_id: id, tag_id: tagId })),
          );
        }
      }
      // 身份、标签、内容与支持包引用必须共同提交，revision 冲突会回滚全部修改。
      if (hasContentChange || hasDerivedPackage) {
        await saveProblemDraft(id, {
          content: (nextContent ?? problemDraft.content) as ProblemDraftContent,
          expectedRevision,
          actorId: c ? c.get("userId") : userId,
          context: c,
        }, tx);
      }
      if (hasDerivedPackage) {
        await registerLegacyStorageObject(
          input.support_package_storage_url!,
          tx,
        );
        await setDraftObject(id, {
          role: "support_package",
          path: "package.zip",
          storage_url: input.support_package_storage_url!,
        }, tx);
      }
    });
  }

  // 审计日志：runtime_config 变更（客观题套卷无此字段，跳过）
  if (!isObjective && input.runtime_config !== undefined) {
    const oldHas = baselineRuntime !== null;
    const newHas = input.runtime_config !== null;
    if (
      oldHas !== newHas ||
      JSON.stringify(baselineRuntime) !==
        JSON.stringify(input.runtime_config)
    ) {
      await logAudit(
        "problems.runtime_config_changed",
        {
          action: "problems.runtime_config_changed",
          title: problem.title,
          display_id: String(problem.number),
          old_has_runtime_config: oldHas,
          new_has_runtime_config: newHas,
        },
        { type: "problem", id },
      );
    }
  }

  await publishSearchIndexEvent("problem", id, "upsert");

  return getProblem(id);
}

/**
 * 删除题目。
 *
 * 权限规则：
 * - admin 可删除任意题目
 * - 物理删除只允许源域治理角色，保留历史资源由引用守卫保护
 *
 * @throws {NotFoundError} 题目不存在
 * @throws {ForbiddenError} 权限不足
 */
export async function deleteProblem(
  id: string,
  userId?: string,
  _userRole?: string,
  c?: Context,
): Promise<void> {
  const db = getDb();

  const existing = await db
    .select()
    .from(problems)
    .where(eq(problems.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("题目不存在");
  }

  const problem = existing[0];

  const [sourceDomain] = problem.domain_id
    ? await db.select({ slug: domains.slug }).from(domains).where(
      eq(domains.id, problem.domain_id),
    )
    : [{ slug: DEFAULT_DOMAIN_SLUG }];
  if (!sourceDomain) throw new NotFoundError("源题工作空间不存在");
  const workspace = await loadWorkspace(
    sourceDomain.slug,
    c?.var.userId ?? userId ?? ROOT_USER_ID,
    { write: true },
  );
  assertWorkspacePermission(workspace.context, "problem:delete_any");

  // 被竞赛引用禁删（应用层保护，竞赛题关联 future-proof）
  const [contestRef] = await db
    .select({ problem_id: contestProblems.problem_id })
    .from(contestProblems)
    .where(eq(contestProblems.problem_id, id))
    .limit(1);
  if (contestRef) {
    throw new ConflictError("题目已被竞赛引用，无法删除");
  }

  // 收集待清理的存储对象（题目投影支持包 + 草稿/版本文件引用）。
  // 统一走引用守卫删除：内容寻址下同一对象可能被其他题目共享，绝不能直接
  // `storage.delete()`（会误删共享字节）。
  const objectUrls = new Set<string>();
  if (problem.support_package_storage_url) {
    objectUrls.add(problem.support_package_storage_url);
  }
  const draftObjectRows = await db.select({
    storage_url: problemDraftObjects.storage_url,
  }).from(problemDraftObjects).where(eq(problemDraftObjects.problem_id, id));
  for (const row of draftObjectRows) objectUrls.add(row.storage_url);
  const versionObjectRows = await db
    .select({ storage_url: problemVersionObjects.storage_url })
    .from(problemVersionObjects)
    .innerJoin(
      problemVersions,
      eq(problemVersions.id, problemVersionObjects.version_id),
    )
    .where(eq(problemVersions.problem_id, id));
  for (const row of versionObjectRows) objectUrls.add(row.storage_url);

  await db.transaction(async (tx) => {
    // 排他题目锁与尝试创建互斥；检查与全部关联清理必须原子提交。
    if (problem.domain_id) {
      await tx.select({ id: domains.id }).from(domains).where(
        eq(domains.id, problem.domain_id),
      ).for("update");
    }
    await tx.select({ id: problems.id }).from(problems).where(
      eq(problems.id, id),
    ).for("update");
    const [contestRef] = await tx.select().from(contestProblems).where(
      eq(contestProblems.problem_id, id),
    ).limit(1);
    if (contestRef) throw new ConflictError("题目已被竞赛引用，无法删除");
    const [active] = await tx.select({ id: submissions.id }).from(submissions)
      .where(and(
        eq(submissions.problem_id, id),
        sql`(${submissions.active_attempt_id} IS NOT NULL OR ${submissions.status} IN ('pending', 'judging'))`,
      )).limit(1);
    const [activeObjective] = await tx.select({ id: objectiveSubmissions.id })
      .from(objectiveSubmissions).where(and(
        eq(objectiveSubmissions.paper_id, id),
        sql`${objectiveSubmissions.active_attempt_id} IS NOT NULL`,
      )).limit(1);
    const [activeSelfTest] = await tx.select({ id: selfTests.id }).from(
      selfTests,
    ).where(and(
      eq(selfTests.problem_id, id),
      sql`${selfTests.status} IN ('pending', 'judging')`,
    )).limit(1);
    if (active || activeObjective || activeSelfTest) {
      throw new AppError(
        "题目存在正在执行的评测，不能删除",
        409,
        "SOURCE_JUDGING",
      );
    }
    await assertProblemHasNoRetainedReferences(id, tx);
    // 终态自测不保留题库引用；先释放其绑定，再清理源题。
    await tx.delete(selfTests).where(eq(selfTests.problem_id, id));
    await tx.delete(problemBindingHistory).where(
      eq(problemBindingHistory.problem_id, id),
    );
    const bindings = await tx.delete(domainProblemBindings).where(
      eq(domainProblemBindings.problem_id, id),
    ).returning();
    if (problem.domain_id && bindings.length) {
      await tx.update(domainResourceCounters).set({
        used: sql`${domainResourceCounters.used} - ${bindings.length}`,
      }).where(
        and(
          eq(domainResourceCounters.domain_id, problem.domain_id),
          eq(domainResourceCounters.resource, "problems"),
        ),
      );
    }
    // 清理关联提交（submissions 无 ON DELETE CASCADE，需手动清理；
    // 评测尝试/分版本判定随提交级联删除）
    await tx.delete(submissions).where(eq(submissions.problem_id, id));

    // 客观题提交：`paper_id` 有 CASCADE，但其 `submitted_version_id` 复合外键
    // （NO ACTION）会阻止随后删除版本行 → 必须先删提交。
    await tx.delete(objectiveSubmissions).where(
      eq(objectiveSubmissions.paper_id, id),
    );

    // 版本与草稿（Handbook §7「补齐新表清理顺序」）：
    // 1. 先删引用行的文件引用（storage_objects 引用守卫依赖"引用已消失"）；
    // 2. 摘掉题目行上的版本指针（problems.latest_version_id / required_version_id
    //    是 NO ACTION 复合外键，不清空则版本行删不掉）；
    // 3. 草稿的 base_version_id 也指向版本（NO ACTION）→ 草稿必须先删；
    // 4. 最后删版本行本身。
    await tx.delete(problemDraftObjects).where(
      eq(problemDraftObjects.problem_id, id),
    );
    await tx.delete(problemVersionObjects).where(
      inArray(
        problemVersionObjects.version_id,
        tx.select({ id: problemVersions.id }).from(problemVersions).where(
          eq(problemVersions.problem_id, id),
        ),
      ),
    );
    await tx.update(problems).set({
      latest_version_id: null,
      required_version_id: null,
      effective_version_mode: "any",
    }).where(eq(problems.id, id));
    await tx.delete(problemDrafts).where(eq(problemDrafts.problem_id, id));
    await tx.delete(problemVersions).where(eq(problemVersions.problem_id, id));

    // 级联删除（problem_tags 的 ON DELETE CASCADE 会自动清理关联）
    await tx.delete(problems).where(eq(problems.id, id));

    await bumpProjectionRevision(tx, globalScopeKey());
    await bumpProjectionRevision(tx, problemScopeKey(id));
  });
  // 存储对象统一经引用守卫删除：仍被其他题目/版本引用时保留字节
  for (const url of objectUrls) {
    try {
      await deleteStorageObject(url);
    } catch (err) {
      await getStorageProvider().catch(() => null);
      logger.error("清理题目存储对象失败", { storage_url: url, err });
    }
  }

  // 审计日志：删除成功后才记录（display_id 为域内数字题号）
  await logAudit(
    "problems.delete",
    {
      action: "problems.delete",
      title: problem.title,
      display_id: String(problem.number),
    },
    { type: "problem", id },
  );

  await publishSearchIndexEvent("problem", id, "delete");
}
