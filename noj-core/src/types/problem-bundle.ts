/**
 * 统一题目包（Problem Bundle）类型与校验。
 *
 * 导入载体 zip 根级必须包含 `problem.json`（manifest）与 `evaluate.py`，
 * 可包含 `statement.md`（题面）与任意评测内容（testcase 不标准化）。
 *
 * 与 `problem-bundle-import` spec 对齐：
 * - manifest 顶层字段映射 `CreateProblemInput`（title/difficulty/type/number/runtime_config）
 * - `runtime_config.evaluator.command` 可缺省，导入时注入默认值 `python3 /workspace/evaluate.py`
 * - 校验失败抛 `BadRequestError`（HTTP 400）
 */

import { BadRequestError } from "../lib/errors.ts";
import { validateRuntimeConfig } from "../services/problems/problems-types.ts";
import {
  type CreateQuestionInput,
  isValidQuestionType,
  type ObjectiveAnswerValue,
  type ObjectiveOption,
  validateAnswerForType,
  validateOptions,
} from "./objective.ts";
import {
  DIFFICULTIES,
  isValidDifficulty,
  isValidLlmConfig,
  isValidProblemType,
  isValidSubmissionMode,
  type LlmConfig,
  type RuntimeConfig,
} from "./problems.ts";

/** 当前 manifest 格式版本。 */
export const BUNDLE_FORMAT_VERSION = 1 as const;

/** `evaluator.command` 缺省时注入的默认评测命令（与 judge 端 /workspace 约定对齐）。 */
export const DEFAULT_EVALUATOR_COMMAND = "python3 /workspace/evaluate.py";

/** 导入载体 zip 中剥离的固定元数据条目名。 */
export const BUNDLE_METADATA_ENTRIES = [
  "problem.json",
  "statement.md",
] as const;

/** manifest 中可选的样例对。 */
export interface ProblemBundleSample {
  input: string;
  output: string;
}

/**
 * 统一题目包 manifest（`problem.json`）。
 *
 * `runtime_config` 的 `evaluator.command` 允许缺省（运行时校验前注入默认值）。
 */
export interface ProblemBundleManifest {
  format_version: number;
  title: string;
  /** 题面 Markdown（`statement.md` 存在时以文件为准，本字段作为兜底） */
  description?: string;
  difficulty?: string;
  type?: string;
  /** 仅 admin 生效：幂等键（(type, number) 匹配既有题目则更新）；缺省 → type 内 MAX+1 */
  number?: number;
  /** 标签名数组，按 name 匹配已有标签，缺省忽略 + warning（issue #223） */
  tags?: string[];
  samples?: ProblemBundleSample[];
  /** 模板文件索引（纯文件名，缺省默认 "template.py"）：前端编辑器初始代码 */
  template?: string;
  /** 提交模式：code（默认）或 artifact */
  submission_mode?: string;
  /** artifact 提交大小上限（MB），可空 */
  artifact_max_size_mb?: number | null;
  /** LLM 配置（可空）：仅 P 型/官方题可启用，且必须开启 evaluator 网络 */
  llm?: LlmConfig;
  /** 客观题套卷标记：true 时使用 questions.json，不要求 runtime_config/evaluate.py */
  is_objective?: boolean;
  /** 编程题必填；客观题缺省 */
  runtime_config?: RuntimeConfig;
}

/**
 * 注入 `evaluator.command` 默认值（深拷贝，不修改入参）。
 *
 * `validateRuntimeConfig` 强制 command 非空，因此默认值注入必须在
 * 结构校验之前完成——落库后的 runtime_config 与既有题目结构一致。
 */
export function resolveManifestCommand(rc: RuntimeConfig): RuntimeConfig {
  const evaluator = { ...rc.evaluator };
  if (typeof evaluator.command !== "string" || !evaluator.command.trim()) {
    evaluator.command = DEFAULT_EVALUATOR_COMMAND;
  }
  return { ...rc, evaluator };
}

/**
 * 仅接受 `.zip` 后缀（路由层复用）。
 */
export function isValidProblemBundleName(name: string): boolean {
  return name.toLowerCase().endsWith(".zip");
}

/**
 * 校验模板文件名是否合法（纯文件名）。
 *
 * 模板名禁止路径分隔符（`/`、`\`）与 `..`，防止读取/打包时路径穿越。
 * 导入校验（validateBundleManifest）、模板读取（getProblemTemplate）与
 * 打包排除（noj.ts resolveTemplateExclude）共用同一规则。
 */
export function isValidTemplateFileName(name: string): boolean {
  return name.trim().length > 0 &&
    !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

/**
 * 校验 manifest 结构与字段合法性，返回规范化副本（不修改入参）。
 *
 * 校验项：
 * - `format_version` 必须等于 `BUNDLE_FORMAT_VERSION`
 * - `title` 非空字符串
 * - `difficulty`/`type` 枚举合法
 * - `number` 类型合法
 * - `tags` 为字符串数组
 * - `samples` 为 `{ input, output }` 数组
 * - `runtime_config` 必填：先注入 command 默认值，再通过 `validateRuntimeConfig`
 *
 * @throws {BadRequestError} 任一字段非法，错误信息指明字段
 */
export function validateBundleManifest(
  raw: unknown,
): ProblemBundleManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BadRequestError("problem.json 必须是 JSON 对象");
  }
  const m = raw as Record<string, unknown>;

  if (
    m.is_objective !== undefined && typeof m.is_objective !== "boolean"
  ) {
    throw new BadRequestError("manifest.is_objective 必须是布尔值");
  }
  const isObjective = m.is_objective === true;

  if (m.format_version !== BUNDLE_FORMAT_VERSION) {
    throw new BadRequestError(
      `不支持的 manifest 格式版本：${
        String(m.format_version)
      }（当前支持 ${BUNDLE_FORMAT_VERSION}）`,
    );
  }

  if (typeof m.title !== "string" || !m.title.trim()) {
    throw new BadRequestError("manifest.title 必须是非空字符串");
  }

  if (
    m.difficulty !== undefined &&
    (!isValidDifficulty(m.difficulty as string))
  ) {
    throw new BadRequestError(
      `非法难度值：${String(m.difficulty)}，仅允许 ${DIFFICULTIES.join("/")}`,
    );
  }

  if (m.type !== undefined && !isValidProblemType(m.type as string)) {
    throw new BadRequestError(
      `非法题目类型：${String(m.type)}，仅允许 U/P`,
    );
  }

  if (
    m.number !== undefined &&
    (typeof m.number !== "number" || !Number.isInteger(m.number) ||
      m.number <= 0)
  ) {
    throw new BadRequestError("manifest.number 必须是正整数");
  }

  if (
    m.tags !== undefined &&
    (!Array.isArray(m.tags) ||
      m.tags.some((c) => typeof c !== "string" || !c.trim()))
  ) {
    throw new BadRequestError("manifest.tags 必须是字符串数组");
  }

  if (m.samples !== undefined) {
    if (
      !Array.isArray(m.samples) ||
      m.samples.some(
        (s) =>
          typeof s !== "object" ||
          s === null ||
          typeof (s as ProblemBundleSample).input !== "string" ||
          typeof (s as ProblemBundleSample).output !== "string",
      )
    ) {
      throw new BadRequestError(
        "manifest.samples 必须是 { input, output } 字符串对象数组",
      );
    }
  }

  if (m.template !== undefined) {
    if (typeof m.template !== "string" || !m.template.trim()) {
      throw new BadRequestError("manifest.template 必须是非空字符串");
    }
    // 模板安全校验：禁止路径分隔符与 ..（与 solution.entry 旧校验同风格）
    if (!isValidTemplateFileName(m.template)) {
      throw new BadRequestError(
        `manifest.template 含非法字符：${m.template}`,
      );
    }
  }

  // 提交模式校验
  if (
    m.submission_mode !== undefined &&
    !isValidSubmissionMode(m.submission_mode as string)
  ) {
    throw new BadRequestError(
      `非法提交模式：${String(m.submission_mode)}，仅允许 code / artifact`,
    );
  }

  // artifact 大小上限校验
  if (
    m.artifact_max_size_mb !== undefined &&
    m.artifact_max_size_mb !== null &&
    (typeof m.artifact_max_size_mb !== "number" ||
      !Number.isInteger(m.artifact_max_size_mb) ||
      m.artifact_max_size_mb <= 0)
  ) {
    throw new BadRequestError(
      "manifest.artifact_max_size_mb 必须为正整数或 null",
    );
  }

  // LLM 配置校验：仅 P 型/官方题可启用，且必须开启 evaluator 网络。
  let llm: LlmConfig | undefined;
  if (m.llm !== undefined && m.llm !== null) {
    if (!isValidLlmConfig(m.llm)) {
      throw new BadRequestError("manifest.llm 格式非法");
    }
    if ((m.type ?? "U") !== "P") {
      throw new BadRequestError("仅 P 型/官方题可启用 LLM");
    }
    llm = m.llm as LlmConfig;
  }

  let runtimeConfig: RuntimeConfig | undefined;
  if (isObjective) {
    if (m.runtime_config !== undefined) {
      throw new BadRequestError("客观题套卷不允许提供 runtime_config");
    }
    if (m.llm !== undefined) {
      throw new BadRequestError("客观题套卷不允许提供 llm");
    }
    if (m.template !== undefined) {
      throw new BadRequestError("客观题套卷不允许提供 template");
    }
    if (m.submission_mode !== undefined) {
      throw new BadRequestError("客观题套卷不允许提供 submission_mode");
    }
    if (m.artifact_max_size_mb !== undefined) {
      throw new BadRequestError("客观题套卷不允许提供 artifact_max_size_mb");
    }
  } else {
    if (typeof m.runtime_config !== "object" || m.runtime_config === null) {
      throw new BadRequestError("manifest.runtime_config 是必填字段");
    }

    // 注入 command 默认值后执行既有结构校验（含镜像白名单由调用方在落库前校验）
    runtimeConfig = resolveManifestCommand(
      m.runtime_config as RuntimeConfig,
    );
    validateRuntimeConfig(runtimeConfig);

    if (llm !== undefined && !runtimeConfig.evaluator.network?.enabled) {
      throw new BadRequestError("启用 LLM 必须开启 evaluator 网络");
    }
  }

  return {
    format_version: m.format_version as number,
    title: m.title as string,
    description: m.description as string | undefined,
    difficulty: m.difficulty as string | undefined,
    type: m.type as string | undefined,
    number: m.number as number | undefined,
    tags: m.tags as string[] | undefined,
    samples: m.samples as ProblemBundleSample[] | undefined,
    template: m.template as string | undefined,
    submission_mode: m.submission_mode as string | undefined,
    artifact_max_size_mb: m.artifact_max_size_mb as number | null | undefined,
    llm,
    is_objective: isObjective,
    runtime_config: isObjective ? undefined : runtimeConfig,
  };
}

/**
 * 校验客观题小题数组（questions.json）。
 *
 * 每项对应 CreateQuestionInput；sort_order 缺省按数组下标；至少 1 道。
 *
 * @throws {BadRequestError} 任一小题非法
 */
export function validateObjectiveQuestions(
  raw: unknown,
): CreateQuestionInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BadRequestError("questions.json 必须是非空数组");
  }
  const seenSort = new Set<number>();
  return raw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new BadRequestError(`questions.json[${index}] 必须是对象`);
    }
    const q = item as Record<string, unknown>;
    const type = q.type;
    if (typeof type !== "string" || !isValidQuestionType(type)) {
      throw new BadRequestError(
        `questions.json[${index}].type 非法，仅允许 single/multiple/judge`,
      );
    }
    if (typeof q.prompt !== "string" || !q.prompt.trim()) {
      throw new BadRequestError(
        `questions.json[${index}].prompt 必须是非空字符串`,
      );
    }

    let options: ObjectiveOption[] | undefined;
    if (type === "judge") {
      options = undefined;
    } else {
      if (q.options === undefined) {
        throw new BadRequestError(`questions.json[${index}].options 必填`);
      }
      try {
        validateOptions(q.options);
      } catch (err) {
        throw new BadRequestError(
          `questions.json[${index}].options 非法：${(err as Error).message}`,
        );
      }
      options = q.options as ObjectiveOption[];
    }

    let answer: ObjectiveAnswerValue[];
    try {
      validateAnswerForType(type, q.answer);
      answer = q.answer as ObjectiveAnswerValue[];
    } catch (err) {
      throw new BadRequestError(
        `questions.json[${index}].answer 非法：${(err as Error).message}`,
      );
    }

    if (type !== "judge" && options) {
      for (const key of answer as string[]) {
        if (!options.some((o) => o.key === key)) {
          throw new BadRequestError(
            `questions.json[${index}].answer 选项 ${key} 不存在于选项中`,
          );
        }
      }
    }

    let sortOrder: number;
    if (q.sort_order === undefined) {
      sortOrder = index;
    } else {
      const rawSort = q.sort_order;
      if (
        typeof rawSort !== "number" || !Number.isInteger(rawSort) ||
        rawSort < 0
      ) {
        throw new BadRequestError(
          `questions.json[${index}].sort_order 必须是非负整数`,
        );
      }
      sortOrder = rawSort;
    }
    if (seenSort.has(sortOrder)) {
      throw new BadRequestError(
        `questions.json 中 sort_order ${sortOrder} 重复`,
      );
    }
    seenSort.add(sortOrder);

    return {
      type,
      prompt: q.prompt,
      options: type === "judge" ? undefined : options,
      answer,
      explanation: typeof q.explanation === "string"
        ? q.explanation
        : undefined,
      sort_order: sortOrder,
    };
  });
}
