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
import { BadRequestError } from "../lib/errors.ts";
import type {
  ProblemResponseWithCategories,
  RuntimeConfig,
} from "../types/problems.ts";

/**
 * 公开题目响应（不含关联分类）。
 */
export interface ProblemResponse {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  support_package_storage_url: string | null;
  has_support_package: boolean;
  runtime_config: RuntimeConfig;
  number: number;
  owner_id: string;
  type: string;
  display_id: string;
  created_at: string;
  updated_at: string;
}

export interface ProblemListResponse {
  items: ProblemResponseWithCategories[];
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
  runtime_config: RuntimeConfig;
  categories: { id: string; name: string; slug: string }[];
  created_at: string;
  updated_at: string;
  number: number;
  owner_id: string;
  owner_username: string;
  type: string;
  display_id: string;
}

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

  const e = rc.evaluator;
  if (typeof e.image !== "string" || !e.image.trim()) {
    throw new BadRequestError(
      "runtime_config.evaluator.image 必须是非空字符串",
    );
  }
  if (typeof e.command !== "string" || !e.command.trim()) {
    throw new BadRequestError(
      "runtime_config.evaluator.command 必须是非空字符串",
    );
  }
  if (typeof e.time_limit_ms !== "number" || e.time_limit_ms <= 0) {
    throw new BadRequestError(
      "runtime_config.evaluator.time_limit_ms 必须为正整数",
    );
  }
  if (typeof e.memory_limit_mb !== "number" || e.memory_limit_mb <= 0) {
    throw new BadRequestError(
      "runtime_config.evaluator.memory_limit_mb 必须为正整数",
    );
  }

  const s = rc.solution;
  if (typeof s.image !== "string" || !s.image.trim()) {
    throw new BadRequestError("runtime_config.solution.image 必须是非空字符串");
  }
  if (typeof s.entry !== "string" || !s.entry.trim()) {
    throw new BadRequestError("runtime_config.solution.entry 必须是非空字符串");
  }
  // entry 安全校验：禁止路径分隔符与 ..
  if (
    s.entry.includes("/") || s.entry.includes("\\") || s.entry.includes("..")
  ) {
    throw new BadRequestError(
      `runtime_config.solution.entry 含非法字符：${s.entry}`,
    );
  }
  if (typeof s.call_timeout_ms !== "number" || s.call_timeout_ms <= 0) {
    throw new BadRequestError(
      "runtime_config.solution.call_timeout_ms 必须为正整数",
    );
  }
  if (typeof s.memory_limit_mb !== "number" || s.memory_limit_mb <= 0) {
    throw new BadRequestError(
      "runtime_config.solution.memory_limit_mb 必须为正整数",
    );
  }
}
