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
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import {
  evaluationResults,
  problems,
  submissions,
} from "./../../../../shared/db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "./../../../../shared/base/errors.ts";
import { getStorageProvider } from "./../../../system/index.ts";
import { logger } from "./../../../../shared/base/logging.ts";
import { validateJudgeImageWithKind } from "../../../system/index.ts";
import { logAudit } from "../../../system/index.ts";
import {
  assertLlmLimitsWithinDefault,
  getLlmProviderById,
} from "../../../gateway/index.ts";
import {
  type CreateProblemInput,
  DIFFICULTIES,
  isValidDifficulty,
  isValidLlmConfig,
  isValidProblemType,
  isValidSubmissionMode,
  type LlmConfig,
  type ProblemResponseWithTags,
  type RuntimeConfig,
  type UpdateProblemInput,
} from "./../../types/problems.ts";
import { validateRuntimeConfig } from "./problems-types.ts";
import { syncProblemTags, validateProblemTagIds } from "./problems-tags.ts";
import { getProblem } from "./problems-list.ts";
import { assertPermission } from "./../../../identity/index.ts";
import {
  assertSensitiveFieldPermissions,
  enforceResourceLimits,
} from "./problem-field-guard.ts";
import type { Context } from "hono";
import { ROOT_USER_ID } from "./../../../../shared/base/constants.ts";

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
  allowServerStorageUrl = false,
): Promise<ProblemResponseWithTags> {
  const db = getDb();

  // NOJ-115/116：服务端流程（import-bundle）以外禁止客户端直传存储 URL。
  if (
    input.support_package_storage_url !== undefined &&
    input.support_package_storage_url !== null &&
    !allowServerStorageUrl
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
    validateRuntimeConfig(input.runtime_config);
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

    // evaluator 联网权限与题目创建权限一致：U 型任意登录用户可开启，
    // P 型仅 admin（由下方类型权限检查保证）。
    // 安全提醒：联网 + 可控 evaluator.command = 联网容器任意命令执行，
    // 开启联网的题目等于把外部网络能力交给出题人（出题人可信边界）。
    // issue #207：敏感字段权限检查（显式设置的字段）——默认放行（default
    // 角色默认授权），收紧后无权限者 403；资源限制字段受管理员全局上限约束。
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
    const provider = await getLlmProviderById(input.llm.provider_id).catch(
      () => null,
    );
    if (!provider || !provider.enabled) {
      throw new BadRequestError("LLM Provider 不存在或已停用");
    }
    const runtime = input.runtime_config;
    if (!runtime || !runtime.evaluator.network?.enabled) {
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
        difficulty: input.difficulty ?? "medium",
        support_package_storage_url: input.support_package_storage_url ?? null,
        runtime_config: isObjective ? null : (input.runtime_config ?? null),
        is_objective: isObjective,
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

  // 处理标签关联（客观题禁止算法标签，校验在 syncProblemTags 内）
  if (input.tag_ids && input.tag_ids.length > 0) {
    await syncProblemTags(id, input.tag_ids, isObjective);
  }

  return getProblem(id);
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
  allowServerStorageUrl = false,
): Promise<ProblemResponseWithTags> {
  const db = getDb();

  // NOJ-115/116：服务端流程（import-bundle）以外禁止客户端直传存储 URL。
  if (
    input.support_package_storage_url !== undefined &&
    input.support_package_storage_url !== null &&
    !allowServerStorageUrl
  ) {
    throw new BadRequestError(
      "support_package_storage_url 仅允许由服务端支持包上传/导入流程生成",
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

  // 权限检查（admin:full_access 通配放行由 assertPermission 内部处理）
  if (problem.type === "P") {
    if (c) {
      await assertPermission(c, "problem:write_any");
    } else if (userRole !== "admin") {
      throw new ForbiddenError("仅管理员可编辑管理题");
    }
  } else if (problem.owner_id === (c?.var.userId ?? userId)) {
    // NOJ-102：U 型 owner 也必须持有 problem:write_own。
    if (c) {
      await assertPermission(c, "problem:write_own");
    }
  } else {
    // U 型：非 owner 需 write_any（管理员）
    if (c) {
      await assertPermission(c, "problem:write_any");
    } else if (userRole !== "admin") {
      throw new ForbiddenError("无权编辑此题目");
    }
  }

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
  if (!isObjective && input.runtime_config !== undefined) {
    if (input.runtime_config === null) {
      throw new BadRequestError("runtime_config 是必填字段，不可清空");
    }
    validateRuntimeConfig(input.runtime_config);
    await validateJudgeImageWithKind(
      input.runtime_config.evaluator.image,
      "evaluator",
    );
    await validateJudgeImageWithKind(
      input.runtime_config.solution.image,
      "solution",
    );

    // evaluator 联网权限与题目编辑权限一致：U 型 owner/admin、P 型 admin
    // （上方权限检查已保证）。
    // issue #207：敏感字段权限检查 + 资源上限校验（与创建路径一致）
    await assertSensitiveFieldPermissions(
      c,
      userId,
      userRole,
      input.runtime_config,
    );
    enforceResourceLimits(input.runtime_config);
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
      const provider = await getLlmProviderById(input.llm.provider_id).catch(
        () => null,
      );
      if (!provider || !provider.enabled) {
        throw new BadRequestError("LLM Provider 不存在或已停用");
      }
      const effectiveRuntime = input.runtime_config ??
        (problem.runtime_config as RuntimeConfig | null);
      if (
        !effectiveRuntime ||
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
      !input.runtime_config.evaluator.network?.enabled
    ) {
      throw new BadRequestError("启用 LLM 的题目必须保持 evaluator 网络开启");
    }
  }

  // 防御性忽略 type 和 number（spec 承诺这两个字段不可变更）
  delete (input as Record<string, unknown>)["type"];
  delete (input as Record<string, unknown>)["number"];

  const updates: Record<string, unknown> = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.description !== undefined) updates.description = input.description;
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
    // 客观题套卷：runtime_config 恒为 NULL（无评测容器），忽略写入
    if (input.runtime_config !== undefined) {
      updates.runtime_config = null;
    }
  } else if (input.runtime_config !== undefined) {
    updates.runtime_config = input.runtime_config;
  }
  if (llmConfig !== undefined) {
    updates.llm_config = llmConfig;
  }
  if (input.submission_mode !== undefined) {
    updates.submission_mode = input.submission_mode;
  }
  if (input.artifact_max_size_mb !== undefined) {
    updates.artifact_max_size_mb = input.artifact_max_size_mb;
  }
  updates.updated_at = new Date().toISOString();

  // 半写入防护：标签校验（存在性 + 客观题 kind 规则）在字段提交之前完成，
  // 校验失败（400）不产生「客户端以为未改、实际已改」的半写入。
  if (input.tag_ids !== undefined) {
    await validateProblemTagIds(input.tag_ids, isObjective);
  }

  await db.update(problems).set(updates).where(eq(problems.id, id));

  // 处理标签关联
  if (input.tag_ids !== undefined) {
    await syncProblemTags(id, input.tag_ids, isObjective);
  }

  // 审计日志：runtime_config 变更（客观题套卷无此字段，跳过）
  if (!isObjective && input.runtime_config !== undefined) {
    const oldHas = problem.runtime_config !== null;
    const newHas = input.runtime_config !== null;
    if (
      oldHas !== newHas ||
      JSON.stringify(problem.runtime_config) !==
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

  // 清理支持包（通过 StorageProvider，幂等）
  const storageUrl = problem.support_package_storage_url;
  if (storageUrl) {
    try {
      const storage = await getStorageProvider();
      await storage.delete(storageUrl);
    } catch (err) {
      logger.error("清理支持包失败", { storage_url: storageUrl, err });
    }
  }

  // 清理关联提交（submissions 无 ON DELETE CASCADE，需手动清理）
  await db.delete(evaluationResults)
    .where(
      inArray(
        evaluationResults.submission_id,
        db.select({ id: submissions.id })
          .from(submissions)
          .where(eq(submissions.problem_id, id)),
      ),
    );
  await db.delete(submissions).where(eq(submissions.problem_id, id));

  // 级联删除（problem_tags 的 ON DELETE CASCADE 会自动清理关联）
  await db.delete(problems).where(eq(problems.id, id));

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
}
