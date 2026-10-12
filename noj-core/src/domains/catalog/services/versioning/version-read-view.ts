/**
 * 版本内容的统一公开响应（Handbook §4.1、§5.3）。
 *
 * 问题的根源：题目详情有**三条**内容读取路径（默认作答版本、显式
 * `?version_id=`、历史版本内容接口），每条各自拼响应字段，导致
 * 1）默认详情返回的 `runtime_config`/题面来自 `problems` 投影（可能是**另一版**），
 *    出现"版本号说 V1、内容却是 V2"的不一致；
 * 2）历史详情与版本内容接口对非编辑者把 AI/OI 的 `runtime_config`（含评测命令、
 *    镜像、网络权限、测试点路径）原样下发——这些正是原题目响应**刻意隐藏**的字段。
 *
 * 因此所有读取路径统一经本模块：
 * - {@link projectProblemContent}：把版本内容覆盖到题目响应字段（只覆盖内容字段，
 *   难度/标签/可见性/所有权仍属题目管理信息）；
 * - {@link trimProblemContentForViewer}：按**字段允许**裁剪（非编辑者去掉评测配置、
 *   LLM 配置、模板、客观题答案与解析）；
 * - {@link buildProblemVersionRead}：合成完整的公开读取载荷，供题目详情、版本内容
 *   接口与竞赛题面共用同一 DTO（竞赛侧经 catalog 门面调用，不复制裁剪逻辑）。
 */
import { getJudgeBackend } from "../../types/runtime-config.ts";
import { getSubmissionLanguages } from "../../types/problems.ts";
import type {
  AiProblemContent,
  OiProblemContent,
  ProblemContentV1,
} from "../../types/problem-content.ts";

/** `problems.judge_type` 的对外取值（存量缺省推断为 dual）。 */
export function persistedJudgeType(
  value: string | null | undefined,
): "dual" | "oi" {
  return value === "oi" ? "oi" : "dual";
}

/**
 * 版本内容中**仅编辑者可见**的字段。
 *
 * 与 `ProblemResponse` 的口径一致：`runtime_config` / `llm_config` 只在
 * owner/admin 响应中出现；`template_content` 是参考模板内容，公开响应也不下发
 * （模板有独立端点）。客观题的 `answer`/`explanation` 同样只给编辑者。
 */
export type VersionContentOverrides = Record<string, unknown>;

/**
 * 把版本内容投影回题目响应字段。
 *
 * 只覆盖**内容**字段：题面、样例、题型派生字段、运行配置与模板；难度、标签、
 * 可见性、所有权、`display_id` 等管理信息沿用题目身份值。
 *
 * @param content 目标版本内容
 * @param includePrivileged 是否包含仅编辑者可见的字段（runtime_config / llm_config /
 *   template_content / 客观题答案）
 */
export function projectProblemContent(
  content: ProblemContentV1,
  includePrivileged: boolean,
): VersionContentOverrides {
  const overrides: VersionContentOverrides = {
    title: content.title,
    description: content.description,
    samples: content.samples ?? [],
  };

  if (content.kind === "ai") {
    const ai = content as AiProblemContent;
    overrides.judge_type = "dual";
    overrides.judge_backend = getJudgeBackend(
      "dual",
      ai.runtime_config,
      false,
    );
    overrides.is_objective = false;
    overrides.submission_mode = ai.submission_mode;
    overrides.artifact_max_size_mb = ai.artifact_max_size_mb;
    overrides.supported_languages = getSubmissionLanguages(
      "dual",
      ai.runtime_config,
    );
    if (includePrivileged) {
      overrides.runtime_config = ai.runtime_config;
      overrides.llm_config = ai.llm_config;
      overrides.template_content = ai.template_content;
    }
    return overrides;
  }

  if (content.kind === "oi") {
    const oi = content as OiProblemContent;
    overrides.judge_type = "oi";
    overrides.judge_backend = getJudgeBackend("oi", oi.runtime_config, false);
    overrides.is_objective = false;
    overrides.submission_mode = "code";
    overrides.artifact_max_size_mb = null;
    overrides.supported_languages = getSubmissionLanguages(
      "oi",
      oi.runtime_config,
    );
    if (includePrivileged) overrides.runtime_config = oi.runtime_config;
    return overrides;
  }

  // 客观题：无评测容器，运行配置恒为空；标准答案只给编辑者。
  overrides.is_objective = true;
  overrides.judge_type = "dual";
  overrides.judge_backend = getJudgeBackend("dual", null, true);
  overrides.submission_mode = "code";
  overrides.artifact_max_size_mb = null;
  overrides.supported_languages = [];
  overrides.runtime_config = null;
  if (includePrivileged) {
    overrides.questions = content.questions;
  } else {
    overrides.questions = content.questions.map((question) => ({
      ...question,
      answer: [],
      explanation: "",
    }));
  }
  return overrides;
}

/**
 * 版本内容的按字段允许裁剪（公开形态）。
 *
 * 非编辑者：AI/OI 去掉 `runtime_config`（评测命令、镜像、资源上限、测试点路径），
 * AI 去掉 `llm_config` 与 `template_content`；客观题去掉答案与解析。
 * 编辑者原样返回。
 */
export function trimProblemContentForViewer(
  content: ProblemContentV1,
  canEdit: boolean,
): ProblemContentV1 {
  if (canEdit) return content;
  if (content.kind === "objective") {
    return {
      ...content,
      questions: content.questions.map((question) => ({
        ...question,
        answer: [],
        explanation: "",
      })),
    };
  }
  if (content.kind === "ai") {
    const trimmed = {
      ...content,
    } as unknown as Record<string, unknown>;
    // 敏感字段整体**移除**（不是置空串/null）：置空会被读成"该版本没有配置/模板"，
    // 而实际语义是"该字段不向此查看者下发"，与题目详情路径的按字段允许一致。
    delete trimmed["runtime_config"];
    delete trimmed["llm_config"];
    delete trimmed["template_content"];
    return trimmed as unknown as ProblemContentV1;
  }
  const trimmedOi = { ...content } as unknown as Record<string, unknown>;
  delete trimmedOi["runtime_config"];
  return trimmedOi as unknown as ProblemContentV1;
}

/** {@link buildProblemVersionRead} 的参数。 */
export interface ProblemVersionReadInput {
  /** 目标版本 ID（默认作答版本或客户端显式指定）。 */
  version_id: string;
  /** 数字版本号（展示用）。 */
  version: number;
  content: ProblemContentV1;
  /** 该版本是否等于 `problems.latest_version_id`。 */
  is_latest: boolean;
  /** 查看者是否可编辑（owner/admin）——决定敏感字段是否下发。 */
  can_edit: boolean;
  /**
   * 该版本是否有可交付的支持包。
   *
   * 由调用方按**该版本**的文件引用解析（不能用题目行的投影，那是"最新版"口径）。
   */
  has_support_package?: boolean;
  /** 支持包存储位置；仅编辑者下发（`support_package_storage_url` 语义）。 */
  support_package_storage_url?: string | null;
}

/**
 * 合成统一的版本读取载荷（题目详情、版本内容接口、竞赛题面共用）。
 *
 * 返回 `ProblemResponse` 子集 + 版本元数据；敏感字段由 `can_edit` 决定：
 * - 非编辑者：不含 `runtime_config` / `llm_config` / `template_content` /
 *   `support_package_storage_url` / 客观题答案；
 * - 编辑者：全量。
 */
export function buildProblemVersionRead(
  input: ProblemVersionReadInput,
): Record<string, unknown> {
  const overrides = projectProblemContent(input.content, input.can_edit);
  const payload: Record<string, unknown> = {
    ...overrides,
    version_id: input.version_id,
    version: input.version,
    is_latest: input.is_latest,
  };
  if (input.has_support_package !== undefined) {
    payload.has_support_package = input.has_support_package;
  }
  if (input.can_edit) {
    payload.support_package_storage_url = input.support_package_storage_url ??
      null;
  }
  return payload;
}
