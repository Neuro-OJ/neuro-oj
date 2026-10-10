/**
 * 题目内容版本模型（Handbook §2.3）。
 *
 * `ProblemContentV1` 是**一份完整的作答与评测内容**：题面、样例与题型专属配置。
 * 发布后内容不可修改；`problems` 表上的内容字段只是"最新版投影"，仅由发布服务更新。
 *
 * 三条不可变约束（首次发布后固定，跨类型转换必须新建题目）：
 * 1. `kind`（objective / oi / ai）；
 * 2. AI 题的 `submission_mode`（code / artifact）；
 * 3. 客观题小题的 `key`（同题跨版本稳定，用于重判时匹配旧答案）。
 */

import { BadRequestError } from "../../../shared/base/errors.ts";
import type { ProblemSample } from "./problem-samples.ts";
import { validateProblemSamples } from "./problem-samples.ts";
import type { OiRuntimeConfig, RuntimeConfig } from "./runtime-config.ts";
import { validateOiRuntimeConfig } from "./runtime-config.ts";
import type { LlmConfig, SubmissionMode } from "./problems.ts";
import { isValidLlmConfig, isValidSubmissionMode } from "./problems.ts";
import type {
  ObjectiveAnswerValue,
  ObjectiveOption,
  QuestionType,
} from "../../objective/index.ts";

/** 当前内容 schema 版本；写入 `problem_versions.schema_version`。 */
export const PROBLEM_CONTENT_SCHEMA_VERSION = 1;

/** 内容类别：客观题 / OI / AI 评测。 */
export type ProblemContentKind = "objective" | "oi" | "ai";

/**
 * 客观题小题快照。
 *
 * `key` 在同题跨版本稳定（迁移时取现有小题 UUID；Web 编辑保留、新增生成 UUID），
 * 重判时按 key 匹配旧答案。
 */
export interface ObjectiveQuestionSnapshot {
  key: string;
  sort_order: number;
  type: QuestionType;
  prompt: string;
  options: ObjectiveOption[];
  answer: ObjectiveAnswerValue[];
  explanation: string;
}

/** 三类内容共有的题面部分。 */
export interface ProblemContentBase {
  title: string;
  description: string;
  samples: ProblemSample[];
}

/** 客观题内容：整卷一次性发布，小题答案随版本固定。 */
export interface ObjectiveProblemContent extends ProblemContentBase {
  kind: "objective";
  questions: ObjectiveQuestionSnapshot[];
}

/** OI 内容：测试点、子任务、checker、语言列表随版本固定。 */
export interface OiProblemContent extends ProblemContentBase {
  kind: "oi";
  runtime_config: OiRuntimeConfig;
}

/** AI 内容：dual 容器配置、模板、产物上限与 LLM 能力声明。 */
export interface AiProblemContent extends ProblemContentBase {
  kind: "ai";
  submission_mode: SubmissionMode;
  runtime_config: RuntimeConfig;
  template_content: string;
  artifact_max_size_mb: number | null;
  llm_config: LlmConfig | null;
}

/** 一份完整、已发布的作答与评测内容。 */
export type ProblemContentV1 =
  | ObjectiveProblemContent
  | OiProblemContent
  | AiProblemContent;

/** 草稿内容：允许暂时缺少完整配置，但 `kind` 与题面骨架必须始终存在。 */
export type ProblemDraftContent = {
  kind: ProblemContentKind;
  title: string;
  description: string;
  samples: ProblemSample[];
} & Record<string, unknown>;

/** 参与内容哈希的文件引用（路径排序后入哈希）。 */
export interface ProblemContentFileRef {
  role: "support_package" | "oi_file";
  path: string;
  /** 未知哈希的存量对象为 `null`，此时不参与内容相等性判定之外的语义。 */
  sha256: string | null;
}

/**
 * 依据题目身份行推导内容类别。
 * U/P 只表示题库归属，不用于表示 AI/OI 题型（Handbook §1.4）。
 */
export function problemContentKindOf(problem: {
  is_objective: boolean;
  judge_type: string;
}): ProblemContentKind {
  if (problem.is_objective) return "objective";
  return problem.judge_type === "oi" ? "oi" : "ai";
}

/**
 * 规范化 JSON：对象键递归排序、丢弃 `undefined`、数组保持顺序。
 *
 * 内容哈希必须对**同一语义内容**稳定：字段书写顺序、对象键顺序都不应影响哈希，
 * 否则"相同内容重复发布"会被误判为新版本。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined)
    .sort();
  return `{${
    keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")
  }}`;
}

/** hex 编码。 */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 计算内容哈希：规范化内容 + 按路径排序的文件哈希。
 *
 * 哈希**不包含**发布说明、操作者与时间（Handbook §2.4），因此"内容相同"的
 * 重复发布可以返回 `unchanged: true` 而不制造空版本。
 */
export async function computeProblemContentHash(
  content: ProblemContentV1,
  files: readonly ProblemContentFileRef[] = [],
): Promise<string> {
  const normalizedFiles = [...files]
    .map((file) => ({
      role: file.role,
      path: file.path,
      sha256: file.sha256 ?? "",
    }))
    .sort((a, b) =>
      a.role === b.role
        ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
        : (a.role < b.role ? -1 : 1)
    );
  const payload = canonicalJson({ content, files: normalizedFiles });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return toHex(new Uint8Array(digest));
}

/** 校验题面骨架（三类内容共用）。 */
function validateBase(value: Record<string, unknown>): void {
  if (typeof value.title !== "string" || value.title.trim().length === 0) {
    throw new BadRequestError("题目内容缺少标题");
  }
  if (typeof value.description !== "string") {
    throw new BadRequestError("题目内容缺少题面");
  }
  if (value.samples === undefined) return;
  try {
    validateProblemSamples(value.samples);
  } catch (error) {
    throw error instanceof BadRequestError
      ? error
      : new BadRequestError("样例格式不合法");
  }
}

/** 校验客观题小题快照数组：key 非空且不重复。 */
export function validateObjectiveQuestionSnapshots(
  value: unknown,
): asserts value is ObjectiveQuestionSnapshot[] {
  if (!Array.isArray(value)) {
    throw new BadRequestError("客观题内容缺少小题数组");
  }
  if (value.length === 0) {
    throw new BadRequestError("客观题发布前必须至少包含一道小题");
  }
  const keys = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") {
      throw new BadRequestError("客观题小题格式不合法");
    }
    const question = item as Record<string, unknown>;
    if (
      typeof question.key !== "string" || question.key.length === 0 ||
      question.key.length > 128
    ) {
      throw new BadRequestError("客观题小题必须携带稳定 key");
    }
    if (keys.has(question.key)) {
      throw new BadRequestError(`客观题小题 key 重复：${question.key}`);
    }
    keys.add(question.key);
    if (
      typeof question.type !== "string" ||
      !["single", "multiple", "judge"].includes(question.type)
    ) {
      throw new BadRequestError(`客观题小题题型不合法：${question.key}`);
    }
    if (typeof question.prompt !== "string") {
      throw new BadRequestError(`客观题小题缺少题干：${question.key}`);
    }
    if (!Array.isArray(question.answer) || question.answer.length === 0) {
      throw new BadRequestError(`客观题小题缺少标准答案：${question.key}`);
    }
  }
}

/**
 * 发布前完整性校验（Handbook §5.3 第 5 步）。
 *
 * 草稿允许不完整；**发布必须完整**：缺运行配置、缺支持包引用、客观题缺小题或
 * 答案都在这里拒绝。
 */
export function validateProblemContent(
  kind: ProblemContentKind,
  value: unknown,
): asserts value is ProblemContentV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("题目内容必须是对象");
  }
  const content = value as Record<string, unknown>;
  if (content.kind !== kind) {
    throw new BadRequestError(
      `题目内容类别不可变：期望 ${kind}，实际 ${String(content.kind)}`,
    );
  }
  validateBase(content);

  if (kind === "objective") {
    validateObjectiveQuestionSnapshots(content.questions);
    return;
  }

  const runtimeConfig = content.runtime_config;
  if (!runtimeConfig || typeof runtimeConfig !== "object") {
    throw new BadRequestError("题目内容缺少运行配置");
  }
  if (kind === "oi") {
    try {
      validateOiRuntimeConfig(runtimeConfig);
    } catch (error) {
      throw error instanceof BadRequestError
        ? error
        : new BadRequestError("OI 运行配置不合法");
    }
    return;
  }

  // AI：submission_mode 必填且合法，artifact 上限与 LLM 配置类型正确
  if (
    typeof content.submission_mode !== "string" ||
    !isValidSubmissionMode(content.submission_mode)
  ) {
    throw new BadRequestError("AI 题目必须声明合法的提交模式");
  }
  const runtime = runtimeConfig as Record<string, unknown>;
  if (!runtime.evaluator || !runtime.solution) {
    throw new BadRequestError("AI 题目运行配置必须包含 evaluator 与 solution");
  }
  if (typeof content.template_content !== "string") {
    throw new BadRequestError("AI 题目必须给出模板内容（可为空串）");
  }
  if (
    content.artifact_max_size_mb !== null &&
    content.artifact_max_size_mb !== undefined &&
    (typeof content.artifact_max_size_mb !== "number" ||
      !Number.isInteger(content.artifact_max_size_mb) ||
      content.artifact_max_size_mb <= 0)
  ) {
    throw new BadRequestError("产物大小上限必须为正整数或 null");
  }
  if (content.llm_config != null && !isValidLlmConfig(content.llm_config)) {
    throw new BadRequestError("LLM 配置不合法");
  }
}

/**
 * 校验题型与提交模式的不可变约束（Handbook §2.3）。
 *
 * 首次发布固定 `kind`，AI 题同时固定 `submission_mode`；跨 AI/OI、
 * 客观题/编程题或 code/artifact 的转换必须新建题目。
 */
export function assertContentKindTransition(
  existingKind: ProblemContentKind,
  existingSubmissionMode: SubmissionMode | null,
  nextContent: ProblemContentV1,
): void {
  if (existingKind !== nextContent.kind) {
    throw new BadRequestError(
      `题目类别不可变（${existingKind} → ${nextContent.kind}）；如需转换请新建题目`,
    );
  }
  if (existingKind !== "ai") return;
  const nextMode = (nextContent as AiProblemContent).submission_mode;
  if (existingSubmissionMode != null && existingSubmissionMode !== nextMode) {
    throw new BadRequestError(
      `提交模式不可变（${existingSubmissionMode} → ${nextMode}）；如需转换请新建题目`,
    );
  }
}
