/**
 * 题目类型定义
 */

/** 题目难度 */
export type ProblemDifficulty = "easy" | "medium" | "hard";

/** 题目列表项（摘要） */
export interface ProblemSummary {
  id: string;
  title: string;
  difficulty: ProblemDifficulty;
  time_limit_ms: number;
  memory_limit_mb: number;
}

/** 题目详情 */
export interface Problem {
  id: string;
  title: string;
  description: string;
  difficulty: ProblemDifficulty;
  time_limit_ms: number;
  memory_limit_mb: number;
  judge_image: string;
  judge_command: string;
  support_package_path?: string;
}

/** 题目创建输入 */
export interface CreateProblemInput {
  title: string;
  description: string;
  difficulty: ProblemDifficulty;
  time_limit_ms: number;
  memory_limit_mb: number;
  judge_image: string;
  judge_command: string;
  support_package_path?: string;
}