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
 * 校验题目类型是否合法。
 */
export function isValidProblemType(value: string): value is ProblemType {
  return PROBLEM_TYPES.includes(value as ProblemType);
}

/**
 * 创建题目请求体。
 */
export interface CreateProblemInput {
  id?: string;
  title: string;
  description: string;
  difficulty?: string;
  judge_image: string;
  judge_command: string;
  support_package_path?: string | null;
  time_limit_ms?: number;
  memory_limit_mb?: number;
  category_ids?: string[];
  /** 题目类型：U（用户题）/ P（主题题），默认 U */
  type?: string;
  /** 题号（同一 type 内独立编号），不传则自动分配 */
  number?: number;
}

/**
 * 更新题目请求体。
 */
export interface UpdateProblemInput {
  title?: string;
  description?: string;
  difficulty?: string;
  judge_image?: string;
  judge_command?: string;
  support_package_path?: string | null;
  time_limit_ms?: number;
  memory_limit_mb?: number;
  category_ids?: string[];
}

/**
 * 题目列表查询参数。
 */
export interface ProblemListQuery {
  page?: number;
  limit?: number;
  difficulty?: string;
  category_id?: string;
  keyword?: string;
  /** 按类型筛选（U/P） */
  type?: string;
  /** 按题号筛选 */
  number?: number;
}

/**
 * 题目响应（含分类信息）。
 */
export interface ProblemResponseWithCategories {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  judge_image: string;
  judge_command: string;
  support_package_path: string | null;
  time_limit_ms: number;
  memory_limit_mb: number;
  categories: { id: string; name: string; slug: string }[];
  created_at: string;
  updated_at: string;
  /** 题号（同一 type 内独立） */
  number: number;
  /** 题目所有者 ID */
  owner_id: string;
  /** 题目类型：U / P */
  type: string;
  /** 展示标识，格式：{type}{number}（如 P1001、U42） */
  display_id: string;
}
