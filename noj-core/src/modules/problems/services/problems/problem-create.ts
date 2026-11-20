/**
 * 题目创建入口：createProblem 与创建期输入校验（拉自 problems-crud.ts，纯搬移）。
 *
 * 依赖：
 * - validateRuntimeConfig / types.ts：DTO 与 runtime 校验
 * - syncProblemTags / problems-tags.ts：标签关联维护（issue #223）
 * - getProblem / problems-list.ts：回读完整结果（避免与上面产生 init 顺序循环）
 *   —— getProblem 是函数级引用，运行时才解析，无循环问题
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { domains, problems } from "../../../../shared/db/schema.ts";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "catalog"]);
import { validateJudgeImageWithKind } from "../../../platform/contracts/cross-module/services_judge-images.ts";
import { assertLlmLimitsWithinDefault } from "../../../platform/contracts/cross-module/gateway_services_llm-limits.ts";
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
} from "../../types/problems.ts";
import { validateProblemRuntimeConfig } from "./problems-types.ts";
import { syncProblemTags } from "./problems-tags.ts";
import { getProblem } from "./problems-list.ts";
import { enqueueSearchIndexTask } from "../../../application/search-tasks.ts";
import {
  assertSensitiveFieldPermissions,
  enforceResourceLimits,
} from "./problem-field-guard.ts";
import type { Context } from "hono";
import type { UserActor } from "../../../access/contracts/actor.ts";
import { ROOT_USER_ID } from "../../../../shared/base/constants.ts";
import { validateProblemSamples } from "../../types/problem-samples.ts";
import {
  deriveDraftContentFromProblem,
  type DraftObjectRef,
  PROBLEM_DRAFT_VIRTUAL_REVISION,
  saveProblemDraft,
  saveProblemDraftWithObjects,
  setDraftObject,
} from "../versioning/draft.ts";
import type { ProblemDraftContent } from "../../types/problem-content.ts";
import { registerLegacyStorageObject } from "../../../assets/contracts/cross-module/services_registry.ts";
import {
  bindCreatedDomainProblem,
  prepareDomainProblemCreation,
} from "../workspace/problem-create.ts";
import { DEFAULT_DOMAIN_SLUG } from "../../../../shared/workspace/types.ts";
import { ensureDefaultWorkspaceOn } from "../../../access/domains.ts";
import { createSystemActor } from "../../../runtime/system-actors.ts";

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
      `非法提交模式：${input.submission_mode}，仅允许 code / artifact / prediction / ui`,
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
    validateProblemRuntimeConfig(input.runtime_config, submissionMode);
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
      ((input.submission_mode !== undefined &&
        input.submission_mode !== "code") ||
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
        // prediction 模式无 Solution 容器，solution 可省略；显式提供时才校验。
        if (input.runtime_config.solution) {
          await validateJudgeImageWithKind(
            input.runtime_config.solution.image,
            "solution",
          );
        }
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
    // prediction 路径不注入 NOJ_LLM_* 环境变量（评测只跑 Evaluator、无 Solution
    // 调用语义），题目级 LLM 配置不会生效。此处 fail-fast，避免出题人配好后在
    // 提交期才拿到「环境变量未配置」的评测错误。
    if (submissionMode === "prediction") {
      throw new BadRequestError("预测提交题不支持 LLM 配置");
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
    if (!defaultDomain) {
      await ensureDefaultWorkspaceOn(db, createSystemActor("bootstrap"));
    }
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

  await enqueueSearchIndexTask("problem", id, "upsert");

  return getProblem(id);
}

/** 新 application 写用例的显式用户合同；旧参数函数仅供迁移期 CLI/测试适配。 */
export function createProblemForActor(
  actor: UserActor,
  input: CreateProblemInput,
  options: {
    allowServerDerivedFields: boolean;
    workspaceSlug?: string;
    initialDraft?: { content: ProblemDraftContent; objects: DraftObjectRef[] };
  },
): Promise<ProblemResponseWithTags> {
  return createProblem(
    input,
    actor.userId,
    undefined,
    undefined,
    options.allowServerDerivedFields,
    options.workspaceSlug,
    options.initialDraft,
  );
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

/** 域题目创建的显式用户合同；不接收 Context 或 role 字符串。 */
export function createDomainProblemForActor(
  actor: UserActor,
  slug: string,
  input: CreateProblemInput,
  options: {
    initialDraft?: { content: ProblemDraftContent; objects: DraftObjectRef[] };
  } = {},
) {
  return createDomainProblem(
    slug,
    input,
    actor.userId,
    undefined,
    options.initialDraft,
  );
}
