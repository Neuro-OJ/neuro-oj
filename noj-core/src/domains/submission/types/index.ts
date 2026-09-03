import type { RuntimeConfig } from "../../catalog/index.ts";

/** LLM 评测任务字段：携带 gateway 地址与短期 eval_token。 */
export interface JudgeTaskLlm {
  gateway_url: string;
  eval_token: string;
  provider_id: string;
  allowed_models: string[];
}

/**
 * 评测任务——从 noj-core 发送到 noj-judge 的消息。
 *
 * 所有评测统一使用双容器模式（Evaluator + Solution）。
 */
export interface JudgeTask {
  /** 提交 UUID */
  submission_id: string;
  /** 题目 UUID */
  problem_id: string;
  /** 双容器 Runtime 配置（必填） */
  runtime_config: RuntimeConfig;
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
  /** 用户 BYOK LLM 字段；只供 judge 处理，不注入 Evaluator 环境。 */
  user_llm?: JudgeTaskLlm;
}

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
  cpp: "main.cpp",
  c: "main.c",
  javascript: "main.js",
};
