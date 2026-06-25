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
 * 创建题目请求体。
 *
 * 注意：`id` 字段已从客户端输入中移除——所有题目统一由服务端生成 UUID。
 * 历史 seed 数据中的字符串 id（如 "1001"）仍可通过 `support_package_path` 关联，
 * 但新题目主键空间完全使用 UUID v4。
 */
export interface CreateProblemInput {
  title: string;
  description: string;
  difficulty?: string;
  judge_image: string;
  judge_command: string;
  support_package_path?: string | null;
  time_limit_ms?: number;
  memory_limit_mb?: number;
  category_ids?: string[];
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
}
