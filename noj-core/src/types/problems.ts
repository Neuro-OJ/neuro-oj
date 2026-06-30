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
  /** 题目类型：U（用户题）/ P（主题题），默认 U */
  type?: string;
  /** 题号（仅 admin 可指定，普通用户自动分配） */
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
  /** 按所有者筛选 */
  owner_id?: string;
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
  /** 是否有已上传的支持包文件 */
  has_support_package: boolean;
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

/**
 * 创建评测镜像白名单条目请求体。
 */
export interface CreateJudgeImageInput {
  image: string;
  mode: "exact" | "all_versions";
  description?: string;
}

/**
 * 更新评测镜像白名单条目请求体。
 */
export interface UpdateJudgeImageInput {
  image?: string;
  mode?: "exact" | "all_versions";
  description?: string;
}

/**
 * 评测镜像白名单条目响应。
 */
export interface JudgeImageResponse {
  id: string;
  image: string;
  mode: string;
  description: string;
  created_at: string;
  updated_at: string;
}

/**
 * 校验 judge_image 是否与白名单匹配。
 * exact 模式：完全相等；all_versions 模式：镜像名去掉标签后匹配。
 */
export function isImageInWhitelist(
  image: string,
  whitelist: { image: string; mode: string }[],
): boolean {
  for (const entry of whitelist) {
    if (entry.mode === "exact") {
      if (image === entry.image) return true;
    } else if (entry.mode === "all_versions") {
      // 去掉标签部分（: 之后的内容），只比较镜像名前缀
      const imageWithoutTag = image.split(":")[0];
      const entryWithoutTag = entry.image.split(":")[0];
      if (imageWithoutTag === entryWithoutTag) return true;
    }
  }
  return false;
}
