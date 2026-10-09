import {
  isOiRuntimeConfig,
  isValidOiCostProfile,
  type OiCostProfile,
  validateOiRuntimeConfig,
} from "../../catalog/index.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  type JudgeType,
  judgeTypeForRuntimeConfig,
  type ProblemRuntimeConfig,
} from "../../catalog/index.ts";

/** LLM 评测任务字段：携带 gateway 地址与短期 eval_token。 */
export interface JudgeTaskLlm {
  gateway_url: string;
  eval_token: string;
  provider_id: string;
  allowed_models: string[];
}

/** 评测任务优先级。 */
export type JudgeTaskPriority = "high" | "medium" | "low";
/** 资源池由服务端运行配置决定，不能由提交者声明。 */
export type JudgeResourcePool = "oi-wasm" | "oi-native" | "ai";

export function judgeResourcePool(
  config: ProblemRuntimeConfig,
): JudgeResourcePool {
  return isOiRuntimeConfig(config)
    ? config.backend === "wasm" ? "oi-wasm" : "oi-native"
    : "ai";
}

/**
 * 评测任务——从 noj-core 发送到 noj-judge 的消息。
 *
 * `judge_type=dual` 使用双容器；`judge_type=oi` 使用传统 OI 测试点协议。
 */
export interface JudgeTask {
  scheduling_version: 1;
  resource_pool: JudgeResourcePool;
  /** 评测尝试标识，与重测序列共同隔离迟到进度及结果。 */
  run_id?: string;
  /** 提交 UUID */
  submission_id: string;
  /** 题目 UUID */
  problem_id: string;
  /** 提交用户 UUID（judge 公平调度：同一用户同时最多 1 个评测在跑） */
  user_id: string;
  /** 评测任务优先级（服务端推导，客户端不可声明） */
  priority: JudgeTaskPriority;
  /** 评测模式；历史消息缺省由 judge 按 dual 兼容处理。 */
  judge_type: JudgeType;
  /** 双容器或 OI Runtime 配置（必填） */
  runtime_config: ProblemRuntimeConfig;
  /** WASM 活动成本快照，仅服务端任务构造允许注入。 */
  oi_cost_profile?: OiCostProfile;
  /** 支持包下载 URL（`noj-download://` 格式） */
  download_url?: string;
  /** artifact 提交的下载 URL（`noj-download://` 格式），仅 artifact 模式携带 */
  artifact_download_url?: string;
  /** 编程语言标识 */
  language: string;
  /** 用户源代码 */
  code: string;
  /** 用户代码的文件名（用于界面展示；容器内由 judge 以硬编码名 `main.py` 注入） */
  file_name?: string;
  /** 重测序列号（重测时递增）。首次提交不传，默认 0。 */
  rejudge_seq?: number;
  /** LLM 评测字段（启用 LLM 的题目携带） */
  llm?: JudgeTaskLlm;
}

/**
 * `buildJudgeTask` 的输入。`code` 允许为空串（artifact 提交不带源码）。
 */
export interface BuildJudgeTaskInput {
  run_id?: string;
  submission_id: string;
  problem_id: string;
  user_id: string;
  priority: JudgeTaskPriority;
  runtime_config: ProblemRuntimeConfig;
  /** WASM 活动成本快照，仅服务端任务构造允许注入。 */
  oi_cost_profile?: OiCostProfile;
  /** 评测模式；缺省根据 runtime_config 推断。 */
  judge_type?: JudgeType;
  language: string;
  code: string;
  file_name?: string;
  download_url?: string;
  artifact_download_url?: string;
  rejudge_seq?: number;
  llm?: JudgeTaskLlm;
}

/**
 * JudgeTask 的**唯一构造入口**（2026-09-12 架构评审 §3.1）。
 *
 * 背景：`JudgeTask` 此前由 6 处内联字面量构造
 * （`submissions-crud` / `submissions-rejudge`×2 / `artifact-submissions` /
 * `self-tests` / `sweeper`），新增字段需要同时改 6 处 + Rust 侧的镜像结构体，
 * 全靠人工记忆；而失败模式是**静默的**——Rust 侧 `Option`/`#[serde(default)]`
 * 会把缺失字段化为默认值，core 加了字段而 judge 不认时不会报错，只会行为异常。
 *
 * 现在：新增字段只需改本函数 + Rust 结构体，并由契约快照测试
 * （`noj-tests/fixtures/judge-task.contract.json`）在两侧同时断言字段集合。
 *
 * 可选字段仅在**有值**时写入，保持消息体最小；Rust 侧对可选字段使用
 * `Option` + `#[serde(skip_serializing_if)]`，两者语义一致。
 */
export function buildJudgeTask(input: BuildJudgeTaskInput): JudgeTask {
  const inferredType = judgeTypeForRuntimeConfig(input.runtime_config);
  if (input.judge_type !== undefined && input.judge_type !== inferredType) {
    throw new BadRequestError("judge_type 与 runtime_config 不一致");
  }
  if (isOiRuntimeConfig(input.runtime_config)) {
    validateOiRuntimeConfig(
      input.runtime_config,
      input.submission_id.startsWith("st_"),
    );
    if (
      !input.runtime_config.languages.includes(input.language as "c" | "cc")
    ) throw new BadRequestError("OI 提交语言不在允许列表");
    if (
      input.runtime_config.backend === "wasm" &&
      !isValidOiCostProfile(input.oi_cost_profile)
    ) throw new BadRequestError("WASM 任务缺少有效的统一标准快照");
    if (input.llm || input.artifact_download_url) {
      throw new BadRequestError("OI 不支持 LLM/artifact 任务");
    }
  }
  const task: JudgeTask = {
    scheduling_version: 1,
    resource_pool: judgeResourcePool(input.runtime_config),
    submission_id: input.submission_id,
    problem_id: input.problem_id,
    user_id: input.user_id,
    priority: input.priority,
    judge_type: input.judge_type ??
      judgeTypeForRuntimeConfig(input.runtime_config),
    runtime_config: structuredClone(input.runtime_config),
    language: input.language,
    code: input.code,
  };
  if (
    isOiRuntimeConfig(input.runtime_config) &&
    input.runtime_config.backend === "wasm"
  ) task.oi_cost_profile = structuredClone(input.oi_cost_profile!);
  if (input.file_name !== undefined) task.file_name = input.file_name;
  if (input.run_id !== undefined) task.run_id = input.run_id;
  if (input.download_url !== undefined) task.download_url = input.download_url;
  if (input.artifact_download_url !== undefined) {
    task.artifact_download_url = input.artifact_download_url;
  }
  if (input.rejudge_seq !== undefined) task.rejudge_seq = input.rejudge_seq;
  if (input.llm !== undefined) task.llm = input.llm;
  return task;
}

/**
 * JudgeTask 的全部字段名（wire 契约）。
 *
 * 契约快照测试用它断言"构造出的对象字段集合 = 契约字段集合"，
 * 因此新增字段忘记登记会立刻失败。
 */
export const JUDGE_TASK_FIELDS: readonly string[] = [
  "scheduling_version",
  "resource_pool",
  "run_id",
  "submission_id",
  "problem_id",
  "user_id",
  "priority",
  "judge_type",
  "runtime_config",
  "oi_cost_profile",
  "download_url",
  "artifact_download_url",
  "language",
  "code",
  "file_name",
  "rejudge_seq",
  "llm",
];

/**
 * 评测结果——从 noj-judge 返回到 noj-core 的消息。
 */
export interface JudgeResult {
  /** 提交 UUID */
  submission_id: string;
  /** 评测状态（由 judge 命令输出决定，新协议下为 finished / error） */
  status: string;
  /** 得分 ×100（如 100 分 = 10000） */
  score: number;
  /** 评测命令的 stdout/stderr 原始输出 */
  output: string;
  /** 结构化结果（用例级详情等），JSON 格式 */
  details: Record<string, unknown>;
  /** 总运行耗时（毫秒） */
  time_ms?: number;
  /** 峰值内存（KB） */
  memory_kb?: number;
  /** 重测序列号，由 noj-judge 透传。用于 saveEvaluationResult 校验。 */
  rejudge_seq?: number;
  /**
   * 评测协议版本（Handbook §5.5）。
   * 缺省（undefined）= 旧协议：core 用提交的 `active_attempt_id` 兜底解析尝试。
   */
  evaluation_protocol_version?: number;
  /** 本次执行的评测尝试 ID（正式提交下等于 `run_id`）。 */
  attempt_id?: string;
  /** 本次执行使用的题目版本 UUID。 */
  problem_version_id?: string;
  /**
   * 判定类别：`graded`（正式判定）/ `platform_error`（平台错误）。
   * 缺省时 core 按状态白名单兜底推导（见 `deriveResultKind`），
   * 新 judge 必须显式携带。
   */
  result_kind?: "graded" | "platform_error";
}

/** 提交的状态枚举。 */
export type SubmissionStatus = "pending" | "judging" | "finished" | "error";

/** 全部提交状态（与 SubmissionStatus 类型一一对应）。 */
export const SUBMISSION_STATUSES: readonly SubmissionStatus[] = [
  "pending",
  "judging",
  "finished",
  "error",
];

/**
 * 穷尽检查辅助：用于 closed union 的 default 分支。
 * 新增状态值时，编译期会因参数不是 never 而报错。
 */
export function assertNever(value: never): never {
  throw new Error(`不可达的分支: ${String(value)}`);
}

/**
 * 判断提交状态是否为终态。
 * 使用 switch + assertNever，新增状态时编译期强制更新。
 */
export function isTerminalSubmissionStatus(status: SubmissionStatus): boolean {
  switch (status) {
    case "pending":
    case "judging":
      return false;
    case "finished":
    case "error":
      return true;
    default:
      return assertNever(status);
  }
}

/**
 * 分数精度常量。
 * score 以 ×100 的整数值存储，读取时除以 SCORE_SCALE 还原。
 */
export const SCORE_SCALE = 100;

/**
 * 将浮点分数转换为存储值。
 * 例：99.5 → 9950
 */
export function scoreToDb(value: number): number {
  return Math.round(value * SCORE_SCALE);
}

/**
 * 将存储值转换为显示分数。
 * 例：9950 → 99.5
 */
export function scoreFromDb(value: number): number {
  return value / SCORE_SCALE;
}

/**
 * 编程语言 → 默认文件名映射（评测 worker 期望的文件名）。
 *
 * 当提交未显式提供 file_name 时，按此表推断默认文件名。
 * 单一来源：所有需要推断默认文件名的服务（createSubmission、
 * rejudgeSubmission、rejudgeProblemSubmissions）均引用此常量。
 */
export const LANGUAGE_EXT_MAP: Record<string, string> = {
  python3: "main.py",
  python: "main.py",
  c: "main.c",
  cc: "main.cpp",
};
