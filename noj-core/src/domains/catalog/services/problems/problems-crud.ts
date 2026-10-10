/**
 * Problems CRUD：createProblem / updateProblem / deleteProblem（PR 拆分 PR-3）。
 *
 * 设计要点：
 * - createProblem 中 MAX+1 重试循环保留原行为不动（已有并发场景验证）
 * - updateProblem 防御性忽略 type / number 字段（spec 承诺不可变）
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
import {
  contestProblems,
  objectiveSubmissions,
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
  BadRequestError,
  ConflictError,
  ForbiddenError,
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
  isValidProblemType,
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
  assertPermission,
  checkPermission,
} from "./../../../identity/index.ts";
import {
  assertSensitiveFieldPermissions,
  enforceResourceLimits,
} from "./problem-field-guard.ts";
import type { Context } from "hono";
import { ROOT_USER_ID } from "./../../../../shared/base/constants.ts";
import { validateProblemSamples } from "../../types/problem-samples.ts";
import {
  deriveDraftContentFromProblem,
  getProblemDraft,
  PROBLEM_DRAFT_VIRTUAL_REVISION,
  type ProblemDraftView,
  saveProblemDraft,
  setDraftObject,
} from "../versioning/draft.ts";
import type {
  ProblemContentKind,
  ProblemContentV1,
  ProblemDraftContent,
} from "../../types/problem-content.ts";
import { registerLegacyStorageObject } from "./../../../system/index.ts";

/**
 * 题目内容编辑权限（唯一判定入口）。
 *
 * 草稿读写、发布版本与既有 PUT 内容更新共用同一口径，避免"草稿接口是旁路"：
 * - P 型：`problem:write_any`（原则上仅管理员）；
 * - U 型 owner：`problem:write_own`；
 * - U 型非 owner：`problem:write_any`。
 *
 * `admin:full_access` 通配由 `assertPermission` 内部放行。
 *
 * @throws {ForbiddenError} 权限不足
 */
export async function assertProblemEditPermission(
  c: Context | undefined,
  problem: { type: string; owner_id: string },
  userId?: string,
  userRole?: string,
): Promise<void> {
  if (problem.type === "P") {
    if (c) {
      await assertPermission(c, "problem:write_any");
    } else if (userRole !== "admin") {
      throw new ForbiddenError("仅管理员可编辑管理题");
    }
    return;
  }
  if (problem.owner_id === (c?.var.userId ?? userId)) {
    // NOJ-102：U 型 owner 也必须持有 problem:write_own。
    if (c) await assertPermission(c, "problem:write_own");
    return;
  }
  if (c) {
    await assertPermission(c, "problem:write_any");
  } else if (userRole !== "admin") {
    throw new ForbiddenError("无权编辑此题目");
  }
}

/**
 * 创建题目。
 *
 * admin 可创建任意 type，普通用户仅限 U 型。
 * 自动设 owner_id 为当前用户，自动分配 U 型 number。
 *
 * @throws {BadRequestError} 难度值非法
 * @throws {ForbiddenError} 普通用户尝试创建 P 型题目
 */
export async function createProblem(
  input: CreateProblemInput,
  userId?: string,
  userRole?: string,
  c?: Context,
  allowServerDerivedFields = false,
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

  // 确定题目类型（默认 U）
  const rawType = input.type?.toUpperCase() ?? "U";
  if (!isValidProblemType(rawType)) {
    throw new BadRequestError(`非法题目类型：${input.type}，仅允许 U/P`);
  }
  const type = rawType;
  if (
    input.visibility !== undefined &&
    !["public", "private"].includes(input.visibility)
  ) throw new BadRequestError("visibility 必须为 public/private");
  if (type === "P" && input.visibility === "private") {
    throw new BadRequestError("P 型题目必须公开");
  }

  // 客观题标记（并入 U/P 题库；无评测容器，服务端即时判定）
  const isObjective = input.is_objective === true;

  // 校验 runtime_config（U/P 型必填，双容器评测；客观题套卷无评测容器）
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

    // evaluator 联网权限与题目创建权限一致：U 型任意登录用户可开启，
    // P 型仅 admin（由下方类型权限检查保证）。
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

  // LLM 配置准入校验：仅 P 型/官方题可启用，且必须开启 evaluator 网络。
  let llmConfig: LlmConfig | null = null;
  if (input.llm !== undefined && input.llm !== null) {
    if (isObjective) {
      throw new BadRequestError("客观题套卷不支持 LLM 配置");
    }
    if (!isValidLlmConfig(input.llm)) {
      throw new BadRequestError("llm 配置格式非法");
    }
    if (type !== "P") {
      throw new ForbiddenError("仅 P 型/官方题可启用 LLM");
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

  // NOJ-102：创建权限按题目类型细粒度强制执行。
  // admin:full_access 通配放行；普通用户需 problem:create（U 型）/
  // problem:create_p（P 型）。无 Context 的 CLI 场景保持旧回退。
  if (type === "P") {
    if (c) {
      await assertPermission(c, "problem:create_p");
    } else if (userRole !== "admin") {
      throw new ForbiddenError("仅管理员可创建管理题");
    }
  } else {
    if (c) {
      await assertPermission(c, "problem:create");
    } else if (
      userRole !== undefined && userRole !== "admin" && userRole !== "user"
    ) {
      throw new ForbiddenError("无权创建题目");
    }
  }

  // 确定所有者
  const ownerId = userId ?? ROOT_USER_ID;

  // 确定题号（同一 type 内自增，并发冲突时重试）
  // 仅 admin 可指定 number；普通用户强制 MAX+1
  const adminProvidedNumber = input.number !== undefined;
  if (adminProvidedNumber) {
    if (c) {
      await assertPermission(c, "problem:write_any");
    } else if (userRole !== "admin") {
      throw new ForbiddenError("仅管理员可指定题号");
    }
  }
  let number = input.number;
  // 半写入防护：标签校验（存在性 + 客观题 kind 规则）在题目行写入之前完成，
  // 校验失败（400）不产生孤儿题目（syncProblemTags 内部仍重复校验兜底）。
  if (input.tag_ids && input.tag_ids.length > 0) {
    await validateProblemTagIds(input.tag_ids, isObjective);
  }

  // 确定题号 + 插入（MAX+1 并发冲突时最多重试 3 次）
  const MAX_RETRIES = 3;
  const now = new Date().toISOString();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (number === undefined) {
      const result = await db
        .select({ max: sql<number>`COALESCE(MAX(${problems.number}), 0)` })
        .from(problems)
        .where(eq(problems.type, type));
      number = (result[0]?.max ?? 0) + 1;
    }

    try {
      await db.insert(problems).values({
        id,
        title: input.title,
        description: input.description,
        samples: input.samples ?? [],
        difficulty: input.difficulty ?? "medium",
        support_package_storage_url: input.support_package_storage_url ?? null,
        runtime_config: isObjective ? null : (input.runtime_config ?? null),
        judge_type: isObjective
          ? "dual"
          : judgeTypeForRuntimeConfig(input.runtime_config),
        is_objective: isObjective,
        visibility: type === "P" ? "public" : (input.visibility ?? "private"),
        submission_mode: submissionMode,
        artifact_max_size_mb: input.artifact_max_size_mb ?? null,
        llm_config: llmConfig,
        number,
        owner_id: ownerId,
        type,
        created_at: now,
        updated_at: now,
      });
      break; // 插入成功，退出重试循环
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      // PostgreSQL UNIQUE 约束冲突错误码 23505
      // postgres.js 在 err.code，PGlite 在 err.cause.code
      const pgCode = err && typeof err === "object"
        ? (err as Record<string, unknown>).code ||
          ((err as Record<string, unknown>).cause as Record<string, unknown>)
            ?.code
        : undefined;
      if (pgCode === "23505") {
        // 管理员指定 number 冲突 → 直接报错，不自动重试
        if (adminProvidedNumber) throw err;
        number = undefined; // 重置 number，下一轮重新 MAX+1
        continue;
      }
      throw err; // 非唯一冲突，直接抛出
    }
  }

  // 每题一个共享草稿（Handbook §2.4/§6.2）：创建即建草稿，初值取自刚写入的
  // 题目投影。此后**所有内容修改走草稿 + 显式发布**，投影只由发布服务更新。
  try {
    const draftContent = await deriveDraftContentFromProblem({
      ...(await db.select().from(problems).where(eq(problems.id, id)).limit(1))[
        0
      ],
    });
    await saveProblemDraft(id, {
      content: draftContent,
      expectedRevision: PROBLEM_DRAFT_VIRTUAL_REVISION,
      actorId: ownerId,
    });
  } catch (err) {
    // 草稿建立失败不能留下"有题目没草稿"的半成品（发布入口依赖草稿 revision）
    await db.delete(problems).where(eq(problems.id, id));
    logger.error("createProblem: 草稿建立失败，已回滚题目行", { id, err });
    throw err;
  }

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

  // 处理标签关联（客观题禁止算法标签，校验在 syncProblemTags 内）
  if (input.tag_ids && input.tag_ids.length > 0) {
    await syncProblemTags(id, input.tag_ids, isObjective);
  }

  await publishSearchIndexEvent("problem", id, "upsert");

  return getProblem(id);
}

/**
 * 把内容补丁合并进草稿内容（Handbook §2.3「内容字段只由发布服务写入投影」）。
 *
 * - `kind` 由目标题型决定（objective / oi / ai），补丁里没有的字段沿用草稿现值，
 *   草稿缺失时回退题目投影；
 * - 客观题小题不接受客户端任意注入：转为客观题时从现有 `objective_questions`
 *   派生快照（迁移期来源，2d 后改为草稿直接维护）；
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
 * - U 型：owner 可更新
 * - P 型：仅 admin 可更新
 * - 禁止修改 type 和 number 字段
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
    if (problem.type === "P" && input.visibility !== "public") {
      throw new BadRequestError("P 型题目必须公开");
    }
    if (
      problem.visibility === "public" && input.visibility === "private" &&
      !(c
        ? await checkPermission(c, "problem:write_any")
        : userRole === "admin")
    ) throw new ForbiddenError("仅管理员可将题目设为私有");
  }

  await assertProblemEditPermission(c, problem, userId, userRole);

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

    // evaluator 联网权限与题目编辑权限一致：U 型 owner/admin、P 型 admin
    // （上方权限检查已保证）。
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

  // LLM 配置变更校验：仅 P 型/官方题可启用，且必须保持 evaluator 网络开启。
  let llmConfig: LlmConfig | null | undefined;
  if (input.llm !== undefined) {
    if (input.llm === null) {
      llmConfig = null;
    } else {
      if (!isValidLlmConfig(input.llm)) {
        throw new BadRequestError("llm 配置格式非法");
      }
      if (problem.type !== "P") {
        throw new ForbiddenError("仅 P 型/官方题可启用 LLM");
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

  // 防御性忽略 type 和 number（spec 承诺这两个字段不可变更）
  delete (input as Record<string, unknown>)["type"];
  delete (input as Record<string, unknown>)["number"];

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
    // 迁移期：未发布题目没有版本，投影仍是唯一读取面（题库列表、编辑器初值），
    // 内容同时写入投影，避免"保存成功但刷新后消失"。
    if (!hasPublishedVersion) {
      updates.title = nextContent.title;
      updates.description = nextContent.description;
      updates.samples = nextContent.samples ?? [];
      if (nextContent.kind === "objective") {
        updates.runtime_config = null;
        updates.template_content = null;
      } else if (nextContent.kind === "oi") {
        updates.runtime_config = nextContent.runtime_config;
        updates.submission_mode = "code";
        updates.artifact_max_size_mb = null;
        updates.template_content = null;
        updates.llm_config = null;
      } else {
        updates.runtime_config = nextContent.runtime_config;
        updates.submission_mode = nextContent.submission_mode;
        updates.artifact_max_size_mb = nextContent.artifact_max_size_mb;
        updates.template_content = nextContent.template_content;
        updates.llm_config = nextContent.llm_config;
      }
    }
  }

  // 半写入防护：标签校验（存在性 + 客观题 kind 规则）在字段提交之前完成，
  // 校验失败（400）不产生「客户端以为未改、实际已改」的半写入。
  const validatedTagIds = input.tag_ids === undefined
    ? undefined
    : await validateProblemTagIds(input.tag_ids, isObjective);

  if (Object.keys(updates).length > 0 || validatedTagIds !== undefined) {
    updates.updated_at = new Date().toISOString();

    // 管理信息、数据引用与标签同时发布，关联写入失败时回滚整次更新。
    await db.transaction(async (tx) => {
      const applied = await tx.update(problems).set(updates).where(
        expectedUpdatedAt === undefined ? eq(problems.id, id) : and(
          eq(problems.id, id),
          eq(problems.updated_at, expectedUpdatedAt),
        ),
      ).returning({ id: problems.id });
      if (applied.length === 0) {
        throw new ConflictError("题目已被修改，请重新加载后保存");
      }
      if (validatedTagIds !== undefined) {
        await tx.delete(problemTags).where(eq(problemTags.problem_id, id));
        if (validatedTagIds.length > 0) {
          await tx.insert(problemTags).values(
            validatedTagIds.map((tagId) => ({ problem_id: id, tag_id: tagId })),
          );
        }
      }
    });
  }

  // 内容写入共享草稿：必须**在投影更新之后**，`saveProblemDraft` 会按题目行
  // 校验内容类别（题型切换时投影先落库才能写入新类别）。
  if (hasContentChange && nextContent) {
    await saveProblemDraft(id, {
      content: nextContent as unknown as ProblemDraftContent,
      expectedRevision: problemDraft.revision,
      actorId: c ? (c.get("userId") as string | undefined) : userId,
    });
  }

  // 服务端派生支持包（题包导入）：登记对象并绑定**草稿**引用，发布时随版本固定，
  // 避免重复导入后发布仍指向旧包。
  if (allowServerDerivedFields && input.support_package_storage_url) {
    try {
      await registerLegacyStorageObject(input.support_package_storage_url);
      await setDraftObject(id, {
        role: "support_package",
        path: "package.zip",
        storage_url: input.support_package_storage_url,
      });
    } catch (err) {
      logger.error("updateProblem: 支持包对象登记失败", {
        id,
        storage_url: input.support_package_storage_url,
        err,
      });
    }
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
          display_id: `${problem.type}${problem.number}`,
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
 * - U 型：owner 可删除
 * - P 型：仅 admin 可删除
 *
 * @throws {NotFoundError} 题目不存在
 * @throws {ForbiddenError} 权限不足
 */
export async function deleteProblem(
  id: string,
  userId?: string,
  userRole?: string,
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

  // 权限检查（admin:full_access 通配放行由 assertPermission 内部处理）
  if (problem.type === "P") {
    if (c) {
      await assertPermission(c, "problem:delete_any");
    } else if (userRole !== "admin") {
      throw new ForbiddenError("仅管理员可删除管理题");
    }
  } else if (problem.owner_id === (c?.var.userId ?? userId)) {
    // NOJ-102：U 型 owner 也必须持有 problem:delete_own。
    if (c) {
      await assertPermission(c, "problem:delete_own");
    }
  } else {
    // U 型：非 owner 需 delete_any（管理员）
    if (c) {
      await assertPermission(c, "problem:delete_any");
    } else if (userRole !== "admin") {
      throw new ForbiddenError("无权删除此题目");
    }
  }

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

  // 清理关联提交（submissions 无 ON DELETE CASCADE，需手动清理；
  // 评测尝试/分版本判定随提交级联删除）
  await db.delete(submissions).where(eq(submissions.problem_id, id));

  // 清理自测记录。
  //
  // 2026-09-21 修复：`self_tests.problem_id → problems.id` 是 `ON DELETE no action`
  // （drizzle/0042 + schema-ddl.ts），但本函数从未清理 self_tests。只要该题
  // 被任何人自测过一次，`DELETE FROM problems` 就会触发
  //   `update or delete on table "problems" violates foreign key constraint
  //    "self_tests_problem_id_fkey" on table "self_tests"`
  // → 全局 onError 转成 500，题目永久无法删除（运维死锁），且报错信息对
  // 调用方完全不可解释。与上面 submissions 的手动清理同一模式。
  await db.delete(selfTests).where(eq(selfTests.problem_id, id));

  // 客观题提交：`paper_id` 有 CASCADE，但其 `submitted_version_id` 复合外键
  // （NO ACTION）会阻止随后删除版本行 → 必须先删提交。
  await db.delete(objectiveSubmissions).where(
    eq(objectiveSubmissions.paper_id, id),
  );

  // 版本与草稿（Handbook §7「补齐新表清理顺序」）：
  // 1. 先删引用行的文件引用（storage_objects 引用守卫依赖"引用已消失"）；
  // 2. 摘掉题目行上的版本指针（problems.latest_version_id / required_version_id
  //    是 NO ACTION 复合外键，不清空则版本行删不掉）；
  // 3. 草稿的 base_version_id 也指向版本（NO ACTION）→ 草稿必须先删；
  // 4. 最后删版本行本身。
  await db.delete(problemDraftObjects).where(
    eq(problemDraftObjects.problem_id, id),
  );
  await db.delete(problemVersionObjects).where(
    inArray(
      problemVersionObjects.version_id,
      db.select({ id: problemVersions.id }).from(problemVersions).where(
        eq(problemVersions.problem_id, id),
      ),
    ),
  );
  await db.update(problems).set({
    latest_version_id: null,
    required_version_id: null,
    effective_version_mode: "any",
  }).where(eq(problems.id, id));
  await db.delete(problemDrafts).where(eq(problemDrafts.problem_id, id));
  await db.delete(problemVersions).where(eq(problemVersions.problem_id, id));

  // 级联删除（problem_tags 的 ON DELETE CASCADE 会自动清理关联）
  await db.delete(problems).where(eq(problems.id, id));

  // 存储对象统一经引用守卫删除：仍被其他题目/版本引用时保留字节
  for (const url of objectUrls) {
    try {
      await deleteStorageObject(url);
    } catch (err) {
      await getStorageProvider().catch(() => null);
      logger.error("清理题目存储对象失败", { storage_url: url, err });
    }
  }

  // 审计日志：删除成功后才记录（display_id 由 type+number 派生）
  await logAudit(
    "problems.delete",
    {
      action: "problems.delete",
      title: problem.title,
      display_id: `${problem.type}${problem.number}`,
    },
    { type: "problem", id },
  );

  await publishSearchIndexEvent("problem", id, "delete");
}
