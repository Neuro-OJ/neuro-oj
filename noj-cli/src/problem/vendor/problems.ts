/**
 * 去掉 Docker 镜像引用中的 tag，保留完整 repository 路径。
 *
 * 这里不能只比较 basename，否则：
 * - `registry-a/team/noj-judge-python:latest`
 * - `registry-b/evil/noj-judge-python:latest`
 * 会被错误地视为同一镜像。
 */
function stripImageTag(name: string): string {
  const lastSlash = name.lastIndexOf("/");
  const lastColon = name.lastIndexOf(":");
  if (lastColon > lastSlash) {
    return name.slice(0, lastColon);
  }
  return name;
}

/** 解析后的镜像引用。 */
export interface ParsedImageRef {
  /** 不含 tag/digest 的 repository 路径 */
  repository: string;
  /** tag（无则 null） */
  tag: string | null;
  /** digest（形如 `sha256:...`，无则 null） */
  digest: string | null;
}

/**
 * 解析 Docker 镜像引用为 repository / tag / digest。
 *
 * 支持 `repo`、`repo:tag`、`repo@sha256:...`、`registry:5000/repo:tag@sha256:...`。
 */
export function parseImageRef(image: string): ParsedImageRef {
  const trimmed = image.trim();
  let rest = trimmed;
  let digest: string | null = null;
  const at = trimmed.lastIndexOf("@");
  if (at >= 0) {
    rest = trimmed.slice(0, at);
    digest = trimmed.slice(at + 1);
  }
  const lastSlash = rest.lastIndexOf("/");
  const lastColon = rest.lastIndexOf(":");
  let tag: string | null = null;
  let repository = rest;
  // 冒号在最后一个斜杠之后才是 tag 分隔符（否则是 registry 端口）
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    repository = rest.slice(0, lastColon);
  }
  return { repository, tag, digest };
}

/**
 * 允许的难度等级。
 */
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = typeof DIFFICULTIES[number];

/**
 * 校验难度值是否合法。
 */
export function isValidDifficulty(value: string): value is Difficulty {
  return DIFFICULTIES.includes(value as Difficulty);
}

/**
 * 允许的题目类型。
 */
export const PROBLEM_TYPES = ["U", "P"] as const;
export type ProblemType = typeof PROBLEM_TYPES[number];

/**
 * 允许的提交模式。
 */
export const SUBMISSION_MODES = ["code", "artifact"] as const;
export type SubmissionMode = typeof SUBMISSION_MODES[number];

/**
 * 校验提交模式是否合法。
 */
export function isValidSubmissionMode(value: string): value is SubmissionMode {
  return SUBMISSION_MODES.includes(value as SubmissionMode);
}

/**
 * 校验题目类型是否合法。
 */
export function isValidProblemType(value: string): value is ProblemType {
  return PROBLEM_TYPES.includes(value as ProblemType);
}

/**
 * 题目 LLM 配置：出题人固定 provider 与 model，做题人不可选择。
 */
export interface LlmConfig {
  provider_id: string;
  model: string;
  /** 单次评测 LLM 调用上限；缺省 = 平台默认 */
  max_calls?: number;
  /** 单次评测 LLM billed token 上限；缺省 = 平台默认 */
  max_tokens?: number;
}

/**
 * 校验 LLM 配置是否合法。
 */
export function isValidLlmConfig(value: unknown): value is LlmConfig {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  const isValidPositiveInt = (v: unknown): boolean =>
    v === undefined ||
    (typeof v === "number" && Number.isInteger(v) && v > 0);
  return typeof obj.provider_id === "string" && obj.provider_id.length > 0 &&
    typeof obj.model === "string" && obj.model.length > 0 &&
    isValidPositiveInt(obj.max_calls) && isValidPositiveInt(obj.max_tokens);
}

/**
 * 双容器 Runtime 配置（与 ./index.ts RuntimeConfig 对齐）。
 *
 * 仅 admin 可设置；普通用户创建题目时该字段被忽略。
 */
import {
  type EvaluatorRuntime,
  type RuntimeConfig,
  type SolutionRuntime,
} from "./runtime-config.ts";
export { type EvaluatorRuntime, type RuntimeConfig, type SolutionRuntime };

/**
 * 创建题目请求体。
 *
 * 注意：`id` 字段已从客户端输入中移除——所有题目统一由服务端生成 UUID。
 * 历史 seed 数据中的字符串 id（如 "1001"）仍可通过 `support_package_storage_url` 关联，
 * 但新题目主键空间完全使用 UUID v4。
 */
export interface CreateProblemInput {
  title: string;
  description: string;
  difficulty?: string;
  support_package_storage_url?: string | null;
  /**
   * 双容器 Runtime 配置。仅 admin 可设置。
   */
  runtime_config?: RuntimeConfig | null;
  tag_ids?: string[];
  /** 题目类型：U（用户题）/ P（主题题），默认 U */
  type?: string;
  /** 客观题标记：true 表示客观题套卷（无评测容器，服务端即时判定） */
  is_objective?: boolean;
  /** 提交模式：code（默认）或 artifact */
  submission_mode?: string;
  /** artifact 提交大小上限（MB），可空 */
  artifact_max_size_mb?: number | null;
  /** LLM 配置（可空）：仅管理员 P 型/官方题或审核题可启用 */
  llm?: LlmConfig | null;
  /** 题号（仅 admin 可指定，普通用户自动分配） */
  number?: number;
}

/**
 * 更新题目请求体。
 */
export interface UpdateProblemInput {
  title?: string;
  description?: string;
  difficulty?: string;
  support_package_storage_url?: string | null;
  /**
   * 双容器 Runtime 配置。设为 null 即清空。
   */
  runtime_config?: RuntimeConfig | null;
  tag_ids?: string[];
  /** 客观题标记变更（由客观题改回编程题时必须同时提供 runtime_config） */
  is_objective?: boolean;
  /** 提交模式变更：code / artifact */
  submission_mode?: string;
  /** artifact 提交大小上限（MB），可空 */
  artifact_max_size_mb?: number | null;
  /** LLM 配置变更（可空）；设为 null 表示移除 LLM 配置 */
  llm?: LlmConfig | null;
}

/**
 * 题目列表查询参数。
 */
export interface ProblemListQuery {
  page?: number;
  limit?: number;
  difficulty?: string;
  tag?: string;
  keyword?: string;
  /** 按类型筛选（U/P） */
  type?: string;
  /** 按题号筛选 */
  number?: number;
  /** 按所有者筛选 */
  owner_id?: string;
}

/**
 * 题目响应中的标签项。
 */
export interface ProblemTagRef {
  id: string;
  name: string;
  kind: string;
}

/**
 * 题目响应（含标签信息）。
 */
export interface ProblemResponseWithTags {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  /** 仅 owner/admin 返回；非 owner/admin 不返回该字段 */
  support_package_storage_url?: string | null;
  /** 是否有已上传的支持包文件 */
  has_support_package: boolean;
  /**
   * 双容器 Runtime 配置（所有题目统一使用双容器模式）。
   * 仅 owner/admin 返回；非 owner/admin 不返回该字段。
   */
  runtime_config?: RuntimeConfig | null;
  tags: ProblemTagRef[];
  /**
   * 存在被隐藏的算法标签时为 true（spoiler 门控：匿名/未 AC viewer
   * 收不到算法标签名称与数量，仅收到此布尔占位标志）。
   */
  has_hidden_algorithm_tags: boolean;
  created_at: string;
  updated_at: string;
  /** 题号（同一 type 内独立） */
  number: number;
  /** 题目所有者 ID */
  owner_id: string;
  /** 题目所有者用户名（详情/列表场景 JOIN users 返回；可能为"未知"） */
  owner_username?: string;
  /** 题目类型：U / P */
  type: string;
  /** 题目可见性：public / private */
  visibility: "public" | "private";
  /** 客观题标记：true 表示客观题套卷（无评测容器，服务端即时判定） */
  is_objective: boolean;
  /** 提交模式：code / artifact */
  submission_mode: SubmissionMode;
  /** artifact 提交大小上限（MB），NULL = 使用 NOJ 硬上限 */
  artifact_max_size_mb: number | null;
  /** LLM 配置（可空，仅 owner/admin 返回） */
  llm_config?: LlmConfig | null;
  /** 展示标识，格式：{type}{number}（如 P1001、U42） */
  display_id: string;
}

/**
 * 镜像用途分类（dual-container-judge §5）。
 *
 * - `evaluator`：单容器 / 双容器 Evaluator 角色（默认）
 * - `solution`：双容器 Solution 角色
 */
export const JUDGE_IMAGE_KINDS = ["evaluator", "solution"] as const;
export type JudgeImageKind = typeof JUDGE_IMAGE_KINDS[number];

export function isValidJudgeImageKind(value: string): value is JudgeImageKind {
  return JUDGE_IMAGE_KINDS.includes(value as JudgeImageKind);
}

/**
 * 创建评测镜像白名单条目请求体。
 */
export interface CreateJudgeImageInput {
  image: string;
  mode: "exact" | "all_versions";
  /**
   * 镜像用途分类（dual-container-judge §5）。必填：'evaluator' / 'solution'。
   */
  kind: JudgeImageKind;
  description?: string;
}

/**
 * 更新评测镜像白名单条目请求体。
 */
export interface UpdateJudgeImageInput {
  image?: string;
  mode?: "exact" | "all_versions";
  kind?: JudgeImageKind;
  description?: string;
}

/**
 * 评测镜像白名单条目响应。
 */
export interface JudgeImageResponse {
  id: string;
  image: string;
  mode: string;
  /**
   * 镜像用途分类（dual-container-judge §5）。
   */
  kind: JudgeImageKind;
  description: string;
  created_at: string;
  updated_at: string;
}

/**
 * 校验 judge_image 是否与白名单匹配。
 *
 * - `exact` 模式：完全相等（含 digest，若白名单登记了 digest）。
 * - `all_versions` 模式：repository 路径必须一致；**若白名单条目登记了 digest
 *   （`repo@sha256:...`），则请求的镜像必须携带同一 digest**。
 *
 * 为什么要有 digest 语义（2026-09-12 架构评审 §4.4）：tag 是**可变**的——`latest`
 * 会被覆盖、同名 tag 可被重新推送，因此"tag 匹配"无法保证跑的还是当初审核过的那个
 * 镜像。judge 侧基础镜像早已用 `FROM python:3.12-slim@sha256:...` 钉死，白名单却只比
 * tag，形成不一致的安全水平。
 *
 * 向后兼容：白名单条目未登记 digest 时保持原行为（按 repository/tag 匹配），
 * 因此无需一次性改造存量数据；推荐做法是把条目改为 `repo@sha256:<审核过的 digest>`，
 * 之后任何不携带该 digest 的请求都会被拒绝。
 */
export function isImageInWhitelist(
  image: string,
  whitelist: { image: string; mode: string }[],
): boolean {
  for (const entry of whitelist) {
    if (entry.mode === "exact") {
      if (image === entry.image) return true;
      continue;
    }
    if (entry.mode !== "all_versions") continue;

    const expected = parseImageRef(entry.image);
    const actual = parseImageRef(image);
    if (expected.repository !== actual.repository) continue;

    if (expected.digest) {
      // 白名单登记了 digest → tag 不再作为凭据，必须 digest 一致
      if (actual.digest === expected.digest) return true;
      continue;
    }
    // 未登记 digest：保持历史语义（忽略 tag，repository 必须一致）
    if (stripImageTag(image) === stripImageTag(entry.image)) return true;
  }
  return false;
}
