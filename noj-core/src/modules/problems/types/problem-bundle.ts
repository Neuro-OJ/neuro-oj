/**
 * 统一题目包（Problem Bundle）类型与校验。
 *
 * 导入载体 zip 根级必须包含 `problem.json`（manifest）与 `evaluate.py`，
 * 可包含 `statement.md`（题面）与任意评测内容（testcase 不标准化）。
 *
 * 格式 3 以 `kind`（ai / oi / objective）判别题型，每种题型有封闭的字段集合；
 * AI 题 `runtime_config` 全字段可缺省，导入时以平台缺省值补全。格式 1/2 经
 * `upgradeBundleManifest` 自动转换并告警。noj-cli 直接复用本文件。
 * 校验失败抛 `BadRequestError`（HTTP 400）。
 */

import {
    type ProblemSample,
    validateProblemSamples,
} from "./problem-samples.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
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
    isValidSubmissionMode,
    type LlmConfig,
    type RuntimeConfig,
    SUBMISSION_MODES,
    type SubmissionMode,
} from "./problems.ts";
import {
    type OiRuntimeConfig,
    validateOiRuntimeConfig,
} from "./runtime-config.ts";

/** 当前 manifest 格式版本。 */
export const BUNDLE_FORMAT_VERSION = 3 as const;

/** `evaluator.command` 缺省时注入的默认评测命令（与 judge 端 /workspace 约定对齐）。 */
export const DEFAULT_EVALUATOR_COMMAND = "python3 /workspace/evaluate.py";

/** 导入载体 zip 中剥离的固定元数据条目名。 */
export const BUNDLE_METADATA_ENTRIES = [
    "problem.json",
    "statement.md",
] as const;

/**
 * 统一题目包 manifest（`problem.json`）。
 *
 * `runtime_config` 的 `evaluator.command` 允许缺省（运行时校验前注入默认值）。
 */
export interface ProblemBundleManifest {
    samples?: ProblemSample[];
    format_version: number;
    /** 题型判别：ai（双容器）/ oi（测试点）/ objective（客观题套卷） */
    kind: BundleKind;
    title: string;
    /** 题面 Markdown（`statement.md` 存在时以文件为准，本字段作为兜底） */
    description?: string;
    difficulty?: string;
    /** 可选域内题号；导入目标 Domain 由接口路径或命令参数确定。 */
    number?: number;
    /** 标签名数组，按 name 匹配已有标签，缺省忽略 + warning（issue #223） */
    tags?: string[];
    /** 模板文件索引（纯文件名，缺省默认 "template.py"）：前端编辑器初始代码 */
    template?: string;
    /** 提交模式：code（默认）/ artifact / prediction / ui */
    submission_mode?: string;
    /** artifact 提交大小上限（MB），可空 */
    artifact_max_size_mb?: number | null;
    /**
     * LLM 配置（可空）：声明单次预算，必须开启 evaluator 网络。
     * 只声明预算；Provider/模型由使用域配置决定。旧字段
     * `provider_id` / `model` 容忍并忽略。
     */
    llm?: LlmConfig;
    /** 由 kind 推导，供下游沿用（objective → true） */
    is_objective: boolean;
    /** 由 kind 推导，供下游沿用（oi → "oi"，其余 "dual"） */
    judge_type: "dual" | "oi";
    /** AI 题为补全缺省值后的完整配置；OI 题为 OI 结构；客观题无。 */
    runtime_config?: RuntimeConfig | OiRuntimeConfig;
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
 * 导入校验（validateBundleManifest）、模板读取（readBundleTemplate /
 * getProblemTemplate）与打包（noj-cli `problem pack`、`problems:build`）共用。
 */
export function isValidTemplateFileName(name: string): boolean {
    return name.trim().length > 0 &&
        !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

/** manifest 未声明 `template` 时的默认模板文件名。 */
export const DEFAULT_TEMPLATE_FILE = "template.py";

/**
 * 界面题（`submission_mode: "ui"`）的界面文件名：固定为包根级 `ui.html`。
 *
 * 不提供 manifest 字段：导入时 `problem.json` 会被剥离，运行期无从得知自定义文件名
 * （模板读取同理只认默认名）。
 */
export const UI_FILE = "ui.html";

/** 界面文件的大小上限（512 KiB）：界面应是自包含的单页，不该夹带大资源。 */
export const MAX_UI_HTML_BYTES = 512 * 1024;

/**
 * 编辑器初始代码模板的大小上限（256 KiB）。
 *
 * 模板是"作答骨架"，正常只有几 KB。导入时超过该上限说明作者把大文件当模板
 * （例如整份参考实现），此时不落库并在导入日志告警——避免把无关内容写进
 * `problems.template_content` 文本列，也避免静默吞掉异常。
 */
export const MAX_TEMPLATE_BYTES = 256 * 1024;

/** 题型判别值，与 `ProblemDraftContent.kind` 一致。 */
export const BUNDLE_KINDS = ["ai", "oi", "objective"] as const;
export type BundleKind = typeof BUNDLE_KINDS[number];

/** 所有题型通用的 manifest 顶层字段。 */
const COMMON_FIELDS = [
    "format_version",
    "kind",
    "title",
    "description",
    "number",
    "difficulty",
    "tags",
    "samples",
] as const;

/** 每种题型额外允许的顶层字段；不在「通用 ∪ 本题型」内的字段一律拒绝。 */
const KIND_FIELDS: Record<BundleKind, readonly string[]> = {
    ai: [
        "runtime_config",
        "submission_mode",
        "template",
        "artifact_max_size_mb",
        "llm",
    ],
    oi: ["runtime_config"],
    objective: [],
};

/** 格式 1/2 中已知的顶层字段（升级时保留，交给格式 3 校验；其余丢弃并告警）。 */
const LEGACY_KNOWN_FIELDS = new Set<string>([
    ...COMMON_FIELDS,
    ...KIND_FIELDS.ai,
]);

/** AI 题 `runtime_config` 缺省值（镜像名不含仓库前缀，由 `imageBase` 补全）。 */
export const AI_RUNTIME_DEFAULTS = {
    evaluator: {
        image: "noj-evaluator-python",
        command: DEFAULT_EVALUATOR_COMMAND,
        time_limit_ms: 5000,
        memory_limit_mb: 512,
    },
    solution: {
        image: "noj-solution-python",
        call_timeout_ms: 5000,
        memory_limit_mb: 512,
    },
} as const;

/** 拼接官方评测镜像全名；`imageBase` 对应部署配置 `JUDGE_IMAGE_BASE`。 */
export function officialJudgeImage(name: string, imageBase = ""): string {
    const base = imageBase.replace(/\/+$/, "");
    return base ? `${base}/${name}` : name;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把任意受支持版本的 manifest 升级为格式 3 结构（纯函数，不注入平台缺省值）。
 *
 * 导入期解析与 `noj problem migrate` 共用：格式 1（仅 P 题）与格式 2 按固定规则
 * 转换并返回告警；格式 3 只检查 `kind` 合法。字段合法性由
 * `validateBundleManifest` 负责。
 */
export function upgradeBundleManifest(raw: unknown): {
    manifest: Record<string, unknown>;
    warnings: string[];
} {
    if (!isPlainObject(raw)) {
        throw new BadRequestError("problem.json 必须是 JSON 对象");
    }
    const source = { ...raw };
    const version = source.format_version;
    if (version === BUNDLE_FORMAT_VERSION) {
        if (!BUNDLE_KINDS.includes(source.kind as BundleKind)) {
            throw new BadRequestError(
                `manifest.kind 必须是 ${BUNDLE_KINDS.join(" / ")} 之一`,
            );
        }
        return { manifest: source, warnings: [] };
    }
    if (version !== 1 && version !== 2) {
        throw new BadRequestError(
            `不支持的 manifest 格式版本：${
                String(version)
            }（支持 1 / 2 / ${BUNDLE_FORMAT_VERSION}）`,
        );
    }
    if (version === 1 && source.type !== "P") {
        throw new BadRequestError(
            "格式 1 仅支持 P 题包转换；U 题包或未声明分类的旧题包请先转换为格式 3",
        );
    }
    if (version === 2 && source.type !== undefined) {
        throw new BadRequestError(
            "格式 2 不允许 manifest.type；题目归属由导入目标 Domain 决定",
        );
    }

    const isObjective = source.is_objective ?? false;
    if (typeof isObjective !== "boolean") {
        throw new BadRequestError("manifest.is_objective 必须是布尔值");
    }
    const judgeType = source.judge_type ?? "dual";
    if (judgeType !== "dual" && judgeType !== "oi") {
        throw new BadRequestError("manifest.judge_type 仅允许 dual/oi");
    }
    if (isObjective && judgeType === "oi") {
        throw new BadRequestError("客观题套卷不允许 judge_type=oi");
    }
    const kind: BundleKind = isObjective
        ? "objective"
        : judgeType === "oi"
        ? "oi"
        : "ai";

    const warnings: string[] = [];
    const manifest: Record<string, unknown> = {
        format_version: BUNDLE_FORMAT_VERSION,
        kind,
    };
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(source)) {
        if (
            key === "format_version" || key === "kind" || key === "type" ||
            key === "is_objective" || key === "judge_type"
        ) continue;
        if (key === "domain_id") {
            warnings.push("已移除题包中的部署 Domain ID；目标域由导入入口决定");
            continue;
        }
        if (!LEGACY_KNOWN_FIELDS.has(key)) {
            dropped.push(key);
            continue;
        }
        manifest[key] = value;
    }
    if (dropped.length > 0) {
        warnings.push(`已忽略格式 3 不支持的字段：${dropped.join(", ")}`);
    }
    if (isPlainObject(manifest.llm)) {
        const llm = manifest.llm;
        manifest.llm = {
            ...(llm.max_calls !== undefined
                ? { max_calls: llm.max_calls }
                : {}),
            ...(llm.max_tokens !== undefined
                ? { max_tokens: llm.max_tokens }
                : {}),
            ...(llm.models !== undefined ? { models: llm.models } : {}),
        };
        if (
            Object.keys(llm).some((key) =>
                key !== "max_calls" && key !== "max_tokens" && key !== "models"
            )
        ) {
            warnings.push(
                "已移除 llm 中的 Provider、模型及其他执行配置；执行配置由使用域决定",
            );
        }
    }
    warnings.push(
        `已将格式 ${version} 题包自动转换为格式 ${BUNDLE_FORMAT_VERSION}；` +
            "可运行 noj problem migrate 更新源 problem.json",
    );
    return { manifest, warnings };
}

/** 校验选项。 */
export interface ValidateBundleManifestOptions {
    /** 官方评测镜像仓库前缀（部署配置 `JUDGE_IMAGE_BASE`），用于补全缺省镜像。 */
    imageBase?: string;
}

/**
 * 用平台缺省值补全 AI 题 `runtime_config`（深拷贝，不修改入参）。
 *
 * 声明 `llm` 时 evaluator 网络缺省开启；显式关闭网络则视为冲突声明。
 * `prediction` 不补全 solution（无 Solution 容器）。
 */
function resolveAiRuntimeConfig(
    raw: unknown,
    mode: SubmissionMode,
    hasLlm: boolean,
    imageBase: string,
): RuntimeConfig {
    if (raw !== undefined && !isPlainObject(raw)) {
        throw new BadRequestError("manifest.runtime_config 必须是对象");
    }
    const rc = structuredClone(raw ?? {}) as Record<string, unknown>;
    if (rc.evaluator !== undefined && !isPlainObject(rc.evaluator)) {
        throw new BadRequestError("runtime_config.evaluator 必须是对象");
    }
    const defaults = AI_RUNTIME_DEFAULTS;
    const evaluator: Record<string, unknown> = {
        ...defaults.evaluator,
        image: officialJudgeImage(defaults.evaluator.image, imageBase),
        ...(rc.evaluator ?? {}),
    };
    if (typeof evaluator.command !== "string" || !evaluator.command.trim()) {
        evaluator.command = DEFAULT_EVALUATOR_COMMAND;
    }
    if (hasLlm) {
        const network = evaluator.network;
        if (isPlainObject(network) && network.enabled === false) {
            throw new BadRequestError(
                "声明 llm 时不能关闭 evaluator 网络（runtime_config.evaluator.network.enabled=false 与 llm 冲突）",
            );
        }
        evaluator.network = {
            ...(isPlainObject(network) ? network : {}),
            enabled: true,
        };
    }
    rc.evaluator = evaluator;
    if (mode !== "prediction") {
        if (rc.solution !== undefined && !isPlainObject(rc.solution)) {
            throw new BadRequestError("runtime_config.solution 必须是对象");
        }
        rc.solution = {
            ...defaults.solution,
            image: officialJudgeImage(defaults.solution.image, imageBase),
            ...(rc.solution ?? {}),
        };
    }
    return rc as unknown as RuntimeConfig;
}

/**
 * 校验 manifest 并返回规范化副本（不修改入参）。
 *
 * 先经 `upgradeBundleManifest` 统一为格式 3，再按「通用字段 + 题型字段」表拒绝
 * 不支持的字段，然后校验各字段；AI 题 `runtime_config` 用平台缺省值补全。
 * 返回值同时给出 `kind` 与等价的 `is_objective` / `judge_type`，供下游沿用。
 *
 * @throws {BadRequestError} 任一字段非法，错误信息指明字段
 */
export function validateBundleManifest(
    raw: unknown,
    options: ValidateBundleManifestOptions = {},
): ProblemBundleManifest {
    const { manifest: m } = upgradeBundleManifest(raw);
    const kind = m.kind as BundleKind;
    const allowed = [...COMMON_FIELDS, ...KIND_FIELDS[kind]];
    for (const key of Object.keys(m)) {
        if (allowed.includes(key)) continue;
        if (key === "is_objective" || key === "judge_type") {
            throw new BadRequestError(
                `格式 ${BUNDLE_FORMAT_VERSION} 不再使用 ${key}，题型由 kind 决定`,
            );
        }
        throw new BadRequestError(
            `kind=${kind} 不支持字段 ${key}；该题型支持：${allowed.join(", ")}`,
        );
    }

    if (typeof m.title !== "string" || !m.title.trim()) {
        throw new BadRequestError("manifest.title 必须是非空字符串");
    }
    if (m.description !== undefined && typeof m.description !== "string") {
        throw new BadRequestError("manifest.description 必须是字符串");
    }

    if (
        m.difficulty !== undefined &&
        (!isValidDifficulty(m.difficulty as string))
    ) {
        throw new BadRequestError(
            `非法难度值：${String(m.difficulty)}，仅允许 ${
                DIFFICULTIES.join("/")
            }`,
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

    if (m.samples !== undefined) validateProblemSamples(m.samples);

    const base = {
        format_version: BUNDLE_FORMAT_VERSION,
        kind,
        title: m.title,
        description: m.description as string | undefined,
        difficulty: m.difficulty as string | undefined,
        number: m.number as number | undefined,
        tags: m.tags as string[] | undefined,
        samples: m.samples as ProblemSample[] | undefined,
    };

    if (kind === "objective") {
        return { ...base, is_objective: true, judge_type: "dual" };
    }

    if (kind === "oi") {
        if (!isPlainObject(m.runtime_config)) {
            throw new BadRequestError("manifest.runtime_config 是必填字段");
        }
        validateOiRuntimeConfig(m.runtime_config);
        return {
            ...base,
            is_objective: false,
            judge_type: "oi",
            runtime_config: structuredClone(
                m.runtime_config,
            ) as unknown as OiRuntimeConfig,
        };
    }

    if (m.template !== undefined) {
        if (typeof m.template !== "string" || !m.template.trim()) {
            throw new BadRequestError("manifest.template 必须是非空字符串");
        }
        // 模板安全校验：禁止路径分隔符与 ..
        if (!isValidTemplateFileName(m.template)) {
            throw new BadRequestError(
                `manifest.template 含非法字符：${m.template}`,
            );
        }
    }

    if (
        m.submission_mode !== undefined &&
        !isValidSubmissionMode(m.submission_mode as string)
    ) {
        throw new BadRequestError(
            `非法提交模式：${String(m.submission_mode)}，仅允许 ${
                SUBMISSION_MODES.join(" / ")
            }`,
        );
    }
    const mode = (m.submission_mode as SubmissionMode | undefined) ?? "code";

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

    // LLM 声明单次预算和模型别名能力，实际映射由使用域决定。
    let llm: LlmConfig | undefined;
    if (m.llm !== undefined && m.llm !== null) {
        if (!isValidLlmConfig(m.llm)) {
            throw new BadRequestError("manifest.llm 格式非法");
        }
        // prediction 路径不注入 NOJ_LLM_*（评测只跑 Evaluator），题目级 LLM 配置
        // 不会生效，导入期即拒绝而不是拖到提交期。
        if (mode === "prediction") {
            throw new BadRequestError("预测提交题不支持 LLM 配置");
        }
        llm = m.llm;
    }

    const runtimeConfig = resolveAiRuntimeConfig(
        m.runtime_config,
        mode,
        llm !== undefined,
        options.imageBase ?? "",
    );
    // 模式只由显式 submission_mode 判定：code/artifact/ui 需要 solution，prediction 可省略。
    validateRuntimeConfig(runtimeConfig, mode);

    return {
        ...base,
        template: m.template as string | undefined,
        submission_mode: m.submission_mode as string | undefined,
        artifact_max_size_mb: m.artifact_max_size_mb as
            | number
            | null
            | undefined,
        llm,
        is_objective: false,
        judge_type: "dual",
        runtime_config: runtimeConfig,
    };
}

/**
 * 客观题题包中小题的可选稳定 key。
 *
 * Handbook §6.4：`questions.json` 支持可选 `key`（同题跨版本稳定，重判时按 key
 * 匹配旧答案）；重复 key 拒绝；未提供时由导入流程生成新 key。导入**不得**按序号
 * 或题干猜测旧小题对应关系。
 */
export type ObjectiveQuestionBundleInput = CreateQuestionInput & {
    key?: string;
};

/**
 * 校验客观题小题数组（questions.json）。
 *
 * 每项对应 CreateQuestionInput（可选 `key`）；sort_order 缺省按数组下标；至少 1 道。
 *
 * @throws {BadRequestError} 任一小题非法
 */
export function validateObjectiveQuestions(
    raw: unknown,
): ObjectiveQuestionBundleInput[] {
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new BadRequestError("questions.json 必须是非空数组");
    }
    const seenSort = new Set<number>();
    const seenKeys = new Set<string>();
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
        // 可选稳定 key：非空字符串且同包内不重复
        let key: string | undefined;
        if (q.key !== undefined) {
            if (typeof q.key !== "string" || !q.key.trim()) {
                throw new BadRequestError(
                    `questions.json[${index}].key 必须是非空字符串`,
                );
            }
            key = q.key.trim();
            if (seenKeys.has(key)) {
                throw new BadRequestError(`questions.json 中 key ${key} 重复`);
            }
            seenKeys.add(key);
        }

        let options: ObjectiveOption[] | undefined;
        if (type === "judge") {
            options = undefined;
        } else {
            if (q.options === undefined) {
                throw new BadRequestError(
                    `questions.json[${index}].options 必填`,
                );
            }
            try {
                validateOptions(q.options);
            } catch (err) {
                throw new BadRequestError(
                    `questions.json[${index}].options 非法：${
                        (err as Error).message
                    }`,
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
                `questions.json[${index}].answer 非法：${
                    (err as Error).message
                }`,
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
            ...(key !== undefined ? { key } : {}),
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
