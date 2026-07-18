/**
 * 评测模式。
 *
 * - `single`（默认）：现有单容器路径，使用 `judge_image` / `judge_command`。
 * - `dual`：双容器编排（Evaluator + Solution），使用 `runtime_config`。
 *
 * 缺省或未识别时按 `single` 处理（向后兼容）。
 */
export type JudgeMode = "single" | "dual";

/**
 * Evaluator 容器运行时配置（双容器模式）。
 */
export interface EvaluatorRuntime {
  /** Docker 镜像名（须在 `judge_images` 白名单中且 kind='evaluator'） */
  image: string;
  /** 评测命令，如 `python3 /workspace/evaluate.py` */
  command: string;
  /** Evaluator 容器总时间上限（毫秒） */
  time_limit_ms: number;
  /** Evaluator 容器内存上限（MB） */
  memory_limit_mb: number;
}

/**
 * Solution 容器运行时配置（双容器模式）。
 */
export interface SolutionRuntime {
  /** Docker 镜像名（须在 `judge_images` 白名单中且 kind='solution'） */
  image: string;
  /** Solution 容器内入口文件名，如 `solution.py` */
  entry: string;
  /** 单次 SDK 调用的时间上限（毫秒）。单次超时不影响 host 进程 */
  call_timeout_ms: number;
  /** Solution 容器内存上限（MB） */
  memory_limit_mb: number;
}

/**
 * 双容器模式的 Runtime 配置。
 */
export interface RuntimeConfig {
  evaluator: EvaluatorRuntime;
  solution: SolutionRuntime;
}

/**
 * 评测任务——从 noj-core 发送到 noj-judge 的消息。
 *
 * 字段语义：
 * - 单容器模式（`mode='single'` 或缺省）：使用 `judge_image` / `judge_command`。
 * - 双容器模式（`mode='dual'`）：使用 `runtime_config`，`judge_image` / `judge_command` 可省略。
 */
export interface JudgeTask {
  /** 提交 UUID */
  submission_id: string;
  /** 题目 UUID */
  problem_id: string;
  /** 评测模式。缺省时按单容器处理 */
  mode?: JudgeMode;
  /** 题目定义的 Docker 镜像名（单容器必填；双容器可选） */
  judge_image?: string;
  /** 容器内执行的评测命令（单容器必填；双容器可选） */
  judge_command?: string;
  /** 支持包下载 URL（`noj-download://` 格式），单/双容器共用 */
  download_url?: string;
  /** 双容器模式的 Runtime 配置 */
  runtime_config?: RuntimeConfig;
  /** 编程语言标识 */
  language: string;
  /** 用户源代码 */
  code: string;
  /** 用户代码的文件名 */
  file_name?: string;
  /**
   * 时间限制（毫秒）。
   * - 单容器：总超时
   * - 双容器：Evaluator 总超时（实际以 `runtime_config.evaluator.time_limit_ms` 为准）
   */
  time_limit_ms: number;
  /**
   * 内存限制（MB）。
   * - 单容器：总内存
   * - 双容器：Evaluator 默认内存（实际以 `runtime_config.evaluator.memory_limit_mb` 为准）
   */
  memory_limit_mb: number;
  /** 重测序列号（重测时递增）。首次提交不传，默认 0。 */
  rejudge_seq?: number;
}

/**
 * 评测结果——从 noj-judge 返回到 noj-core 的消息。
 */
export interface JudgeResult {
  /** 提交 UUID */
  submission_id: string;
  /** 评测状态（由 judge 命令输出决定，如 Accepted、WrongAnswer、Error） */
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
}

/**
 * 提交的状态枚举。
 */
export type SubmissionStatus = "pending" | "judging" | "finished" | "error";

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
  cpp: "main.cpp",
  c: "main.c",
  javascript: "main.js",
};
