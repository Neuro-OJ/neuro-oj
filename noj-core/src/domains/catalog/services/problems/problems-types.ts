/**
 * Problems 公共类型 + runtime_config 校验（PR 拆分 PR-3，与 submissions 同构）。
 *
 * 只放：
 * - 响应 DTO 接口（ProblemResponse / ProblemListResponse / AdminProblemList*）
 * - validateRuntimeConfig：被 crud 与 export 共同依赖的纯函数
 *
 * 不放：
 * - 列表 / CRUD 业务函数（见 problems-list.ts / problems-crud.ts）
 * - DB 行转换（见 problems-list.ts 内部 toProblemResponse）
 * - 输入类型（CreateProblemInput / UpdateProblemInput 等）—— 已迁至 types/problems.ts
 */
import { BadRequestError } from "./../../../../shared/base/errors.ts";
import type {
  LlmConfig,
  ProblemResponseWithTags,
  ProblemRuntimeConfig,
  ProblemTagRef,
  RuntimeConfig,
} from "./../../types/problems.ts";
import {
  isOiRuntimeConfig,
  validateOiRuntimeConfig,
} from "./../../types/problems.ts";

/**
 * 公开题目响应（不含关联标签）。
 */
export interface ProblemResponse {
  samples: import("../../types/problem-samples.ts").ProblemSample[];
  id: string;
  title: string;
  description: string;
  difficulty: string;
  /** 仅 owner/admin 返回；非 owner/admin 不返回该字段 */
  support_package_storage_url?: string | null;
  has_support_package: boolean;
  /** 仅 owner/admin 返回；非 owner/admin 不返回该字段 */
  runtime_config?: ProblemRuntimeConfig | null;
  number: number;
  owner_id: string;
  type: string;
  /** 题目可见性：public / private */
  visibility: "public" | "private";
  /** 客观题标记：true 表示客观题套卷（无评测容器，服务端即时判定） */
  is_objective: boolean;
  /** 评测模式；存量题目缺省推断为 dual。 */
  judge_type: "dual" | "oi";
  /** 可公开的执行后端；客观题或配置不可用时为空。 */
  judge_backend: "dual" | "oi-native" | "oi-wasm" | null;
  /** 提交模式：code / artifact */
  submission_mode: "code" | "artifact";
  /** artifact 提交大小上限（MB），NULL = 使用 NOJ 硬上限 */
  artifact_max_size_mb: number | null;
  /** LLM 配置（可空，仅 owner/admin 返回） */
  llm_config?: LlmConfig | null;
  display_id: string;
  /**
   * 该题目是否被**尚未结束的公开赛**收编（审计 VULN-07）。
   *
   * 语义：
   * - 非特权用户（非管理员且非题目所有者）：这类题目**整行不会出现在列表里**
   *   （后端 SQL 过滤），故该字段恒为 false/不出现——不存在"看得到但被隐藏"的中间态；
   * - 特权用户（管理员 / 题目所有者）：行照常返回，`is_contest_hidden === true`
   *   表示它对普通用户处于隐藏保密状态，前端据此展示浅灰斜纹底 + Tooltip。
   */
  is_contest_hidden?: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * 题目列表项：不返回详情页才有的算法标签门控占位标志。
 * 列表/卡片接口只返回题目标签（kind='problem'）。
 */
export type ProblemListItem = Omit<
  ProblemResponseWithTags,
  "has_hidden_algorithm_tags"
>;

/**
 * 公开题目列表响应（分页）。
 */
export interface ProblemListResponse {
  items: ProblemListItem[];
  total: number;
  page: number;
  limit: number;
}

/**
 * 管理员专属题目列表项（不含 description，额外包含 owner_username）。
 */
export interface AdminProblemListItem {
  id: string;
  title: string;
  difficulty: string;
  support_package_storage_url: string | null;
  runtime_config: ProblemRuntimeConfig;
  judge_type: "dual" | "oi";
  llm_config: LlmConfig | null;
  tags: ProblemTagRef[];
  created_at: string;
  updated_at: string;
  number: number;
  owner_id: string;
  owner_username: string;
  type: string;
  /** 题目可见性：public / private */
  visibility: "public" | "private";
  submission_mode: "code" | "artifact";
  artifact_max_size_mb: number | null;
  display_id: string;
}

/**
 * 管理员题目列表响应（分页）。
 */
export interface AdminProblemListResponse {
  items: AdminProblemListItem[];
  total: number;
  page: number;
  limit: number;
}

/**
 * 校验 runtime_config 结构（不涉及白名单 / kind，调用方负责）。
 *
 * @throws {BadRequestError} 缺字段、类型错、值越界
 */
export function validateRuntimeConfig(rc: RuntimeConfig): void {
  if (!rc.evaluator || typeof rc.evaluator !== "object") {
    throw new BadRequestError("runtime_config.evaluator 必须是对象");
  }
  if (!rc.solution || typeof rc.solution !== "object") {
    throw new BadRequestError("runtime_config.solution 必须是对象");
  }

  const evaluator = rc.evaluator;
  if (typeof evaluator.image !== "string" || !evaluator.image.trim()) {
    throw new BadRequestError(
      "runtime_config.evaluator.image 必须是非空字符串",
    );
  }
  if (typeof evaluator.command !== "string" || !evaluator.command.trim()) {
    throw new BadRequestError(
      "runtime_config.evaluator.command 必须是非空字符串",
    );
  }
  if (
    typeof evaluator.time_limit_ms !== "number" ||
    evaluator.time_limit_ms <= 0
  ) {
    throw new BadRequestError(
      "runtime_config.evaluator.time_limit_ms 必须为正整数",
    );
  }
  if (
    typeof evaluator.memory_limit_mb !== "number" ||
    evaluator.memory_limit_mb <= 0
  ) {
    throw new BadRequestError(
      "runtime_config.evaluator.memory_limit_mb 必须为正整数",
    );
  }

  // evaluator.network（可选，缺省 = 无网）
  if (evaluator.network !== undefined && evaluator.network !== null) {
    if (
      typeof evaluator.network !== "object" || Array.isArray(evaluator.network)
    ) {
      throw new BadRequestError(
        "runtime_config.evaluator.network 必须是对象",
      );
    }
    const network = evaluator.network as { enabled?: unknown };
    if (typeof network.enabled !== "boolean") {
      throw new BadRequestError(
        "runtime_config.evaluator.network.enabled 必须是布尔值",
      );
    }
  }

  const solution = rc.solution;
  if (typeof solution.image !== "string" || !solution.image.trim()) {
    throw new BadRequestError("runtime_config.solution.image 必须是非空字符串");
  }
  // solution.call_timeout_ms：题目级默认调用超时（必填正整数）；
  // evaluator 的 runner.call(..., timeout_ms) 可按调用覆盖，capability 可经 register_capability(timeout_ms=...) 配置
  if (
    typeof solution.call_timeout_ms !== "number" ||
    solution.call_timeout_ms <= 0
  ) {
    throw new BadRequestError(
      "runtime_config.solution.call_timeout_ms 必须为正整数",
    );
  }
  if (
    typeof solution.memory_limit_mb !== "number" ||
    solution.memory_limit_mb <= 0
  ) {
    throw new BadRequestError(
      "runtime_config.solution.memory_limit_mb 必须为正整数",
    );
  }
}

/** 校验题目的任一评测后端配置。 */
export function validateProblemRuntimeConfig(
  rc: ProblemRuntimeConfig,
): void {
  if (isOiRuntimeConfig(rc)) {
    validateOiRuntimeConfig(rc);
    return;
  }
  validateRuntimeConfig(rc as RuntimeConfig);
}
