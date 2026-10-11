/** 已发布版本的执行文件读取。所有提交入口及恢复链路共用，禁止读最新版投影。 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { problemVersionObjects } from "../../../../shared/db/schema.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import {
  getStorageProvider,
  validateJudgeImageWithKind,
} from "../../../system/index.ts";
import {
  enforceResourceLimits,
  isOiRuntimeConfig,
  type LlmConfig,
  type ProblemContentV1,
} from "../../../catalog/index.ts";
import { resolveLlmLimits } from "../../../gateway/index.ts";
import type { JudgeTask } from "../../types/index.ts";

/**
 * 界面提交的脚本模板：以**目标版本**的 `template_content` 为准（版本才是判卷事实源），
 * 未版本化的存量题目回退题目投影。非界面提交无需调用。
 */
export function scriptTemplateOf(
  content: ProblemContentV1 | null | undefined,
  fallback?: string | null,
): string | undefined {
  if (content?.kind === "ai") return content.template_content;
  return fallback ?? undefined;
}

/** 指定版本的支持包地址；不存在引用与后端丢失是不同情况。 */
export async function versionSupportPackageUrl(
  versionId: string,
): Promise<string | null> {
  const [ref] = await getDb().select().from(problemVersionObjects).where(and(
    eq(problemVersionObjects.version_id, versionId),
    eq(problemVersionObjects.role, "support_package"),
    eq(problemVersionObjects.path, "package.zip"),
  )).limit(1);
  return ref?.storage_url ?? null;
}

/** 重新签发下载地址，存量对象缺失时失败，不能无支持包继续评测。 */
export async function versionSupportPackageDownload(
  versionId: string,
): Promise<string | undefined> {
  const url = await versionSupportPackageUrl(versionId);
  if (!url) return undefined;
  const storage = await getStorageProvider();
  if (!(await storage.stat(url)).exists) {
    throw new AppError(
      "目标版本的支持包已缺失",
      409,
      "SUPPORT_PACKAGE_MISSING",
    );
  }
  return await storage.downloadUrl(url);
}

/** 保存实际执行参数，排除源码、短期下载地址与 token。 */ export function executionSnapshot(
  task: JudgeTask,
  llmConfig?: LlmConfig | null,
  previous?: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    language: task.language,
    problem_version_id: task.problem_version_id,
    judge_type: task.judge_type,
    runtime_config: task.runtime_config,
    ...(task.oi_cost_profile ? { oi_cost_profile: task.oi_cost_profile } : {}),
    ...(task.llm && llmConfig
      ? {
        llm_execution: previous?.llm_execution ?? {
          provider_id: task.llm.provider_id,
          // 旧字段：default-only 时为真实模型名，否则为首个别名对应的真实模型
          model: task.llm.model_map
            ? Object.values(task.llm.model_map)[0]
            : task.llm.allowed_models[0],
          ...resolveLlmLimits(llmConfig),
          ...(task.llm.model_map
            ? {
              models: Object.entries(task.llm.model_map).map((
                [alias, model],
              ) => ({ alias, model })),
            }
            : {}),
        },
      }
      : {}),
  };
}

/** 版本接受性输入：提交模式与语言。 */
export interface VersionAcceptanceInput {
  language: string;
  submissionMode: "code" | "artifact" | "prediction" | "ui";
}

/**
 * 目标版本是否接受本次提交的模式与语言（Handbook §5.4 第 1 步）。
 *
 * 抛带稳定 code 的 `AppError`：`CONTENT_KIND_MISMATCH` / `SUBMISSION_MODE_MISMATCH` /
 * `LANGUAGE_NOT_SUPPORTED`。批任务据此写条目 `reason_code`，不得降级为通用平台错误。
 */
export function assertVersionAcceptance(
  content: ProblemContentV1,
  input: VersionAcceptanceInput,
): void {
  if (content.kind === "ai") {
    if (content.submission_mode !== input.submissionMode) {
      throw new AppError(
        `目标版本的提交模式为 ${content.submission_mode}，与本次提交不一致`,
        400,
        "SUBMISSION_MODE_MISMATCH",
      );
    }
    return;
  }
  if (content.kind === "oi") {
    if (!content.runtime_config.languages.includes(input.language as never)) {
      throw new AppError(
        `目标版本不支持该语言：${input.language}`,
        400,
        "LANGUAGE_NOT_SUPPORTED",
      );
    }
    return;
  }
  throw new AppError("客观题版本不接受代码提交", 400, "CONTENT_KIND_MISMATCH");
}

/** 执行前预检输入：目标版本的执行语义 + 本次实际交付物信息。 */
export interface ExecutionPreflightInput extends VersionAcceptanceInput {
  /**
   * 生效的产物大小上限（MB）。缺省时取目标版本内容的 `artifact_max_size_mb`；
   * `null` 表示无版本级限制（仅平台硬上限）。
   */
  artifactMaxSizeMb?: number | null;
  /** 产物实际字节数（已知时校验版本级大小上限）。 */
  artifactByteSize?: number | null;
}

/**
 * 目标版本的**执行前预检**：提交入口与批任务派发必须共用同一套
 * （Handbook §5.4 第 1 步、§7 边界表、tracking #33）。
 *
 * 覆盖四层，全部抛带稳定 code 的 `AppError`：
 * 1. 模式 / 语言被该版本接受（`SUBMISSION_MODE_MISMATCH` / `LANGUAGE_NOT_SUPPORTED`）；
 * 2. 平台镜像白名单（evaluator + solution → `JUDGE_IMAGE_NOT_ALLOWED`）；
 * 3. 管理员配置的资源上限（`RESOURCE_LIMIT_EXCEEDED`，非 OI 题）；
 * 4. 版本级产物大小上限（`ARTIFACT_TOO_LARGE_FOR_VERSION`）。
 *
 * 调用方（批任务条目 / 提交入口）应据此写具体原因码并**保留历史判定**，
 * 不能改成"无 LLM / 无镜像"的静默降级执行。
 */
export async function assertExecutionPreflight(
  content: ProblemContentV1,
  input: ExecutionPreflightInput,
): Promise<void> {
  // 客观题没有运行配置（类型收窄点，同时给出稳定原因码）
  if (content.kind === "objective") {
    throw new AppError(
      "客观题版本不接受代码提交",
      400,
      "CONTENT_KIND_MISMATCH",
    );
  }
  assertVersionAcceptance(content, input);

  const runtimeConfig = content.runtime_config;
  // AI 版本却是 OI 形状的 runtime_config：配置与题型不自洽，不能拿去执行。
  if (content.kind === "ai" && isOiRuntimeConfig(runtimeConfig)) {
    throw new AppError(
      "目标版本的运行配置与题型不一致，无法评测",
      400,
      "CONTENT_KIND_MISMATCH",
    );
  }
  // OI 无容器镜像与平台容器资源上限口径（其限额随版本由发布校验保证）。
  if (isOiRuntimeConfig(runtimeConfig)) return;

  // prediction 版本没有 Solution 容器，solution 缺省时只复验 evaluator 镜像。
  const images: Array<{ image: string; kind: "evaluator" | "solution" }> = [
    { image: runtimeConfig.evaluator.image, kind: "evaluator" },
    ...(runtimeConfig.solution
      ? [{ image: runtimeConfig.solution.image, kind: "solution" as const }]
      : []),
  ];
  for (const item of images) {
    try {
      await validateJudgeImageWithKind(item.image, item.kind);
    } catch (err) {
      if (err instanceof AppError) {
        // 白名单为空 / 镜像被停用：保留原始可读消息与状态码，换成稳定原因码
        throw new AppError(
          err.message,
          err.statusCode,
          "JUDGE_IMAGE_NOT_ALLOWED",
          { image: item.image, image_kind: item.kind },
        );
      }
      throw err;
    }
  }

  // 管理员配置的资源上限（settings-registry 的 judge_max_*）
  enforceResourceLimits(runtimeConfig);

  // 版本级产物大小上限
  const limitMb = input.artifactMaxSizeMb ??
    (content.kind === "ai" ? content.artifact_max_size_mb : null);
  if (
    input.submissionMode !== "code" && limitMb != null &&
    limitMb >= 0 && input.artifactByteSize != null &&
    input.artifactByteSize > limitMb * 1024 * 1024
  ) {
    throw new AppError(
      `产物 ${input.artifactByteSize} 字节超过目标版本上限 ${limitMb}MB`,
      400,
      "ARTIFACT_TOO_LARGE_FOR_VERSION",
      { byte_size: input.artifactByteSize, limit_mb: limitMb },
    );
  }
}
