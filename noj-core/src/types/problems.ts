/**
 * 提取 Docker 镜像的基础名称（去掉 tag 部分）。
 *
 * Docker 镜像引用可能包含 registry 端口和路径：
 *   "noj-judge-python:latest"           → "noj-judge-python"
 *   "registry:5000/my-image:v2"         → "my-image"
 *   "docker.io/library/python:3.12"     → "python"
 *
 * 正确做法：取最后一个 "/" 之后的段落作为镜像名，再用 ":" 分离 tag。
 */
function getImageBase(name: string): string {
  const lastSegment = name.split("/").pop() ?? name;
  return lastSegment.split(":")[0];
}

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
 * 双容器 Runtime 配置（与 noj-judge/src/types.ts RuntimeConfig 对齐）。
 *
 * 仅 admin 可设置；普通用户创建题目时该字段被忽略。
 */
export interface RuntimeConfig {
  evaluator: EvaluatorRuntime;
  solution: SolutionRuntime;
}

export interface EvaluatorRuntime {
  image: string;
  command: string;
  time_limit_ms: number;
  memory_limit_mb: number;
}

export interface SolutionRuntime {
  image: string;
  entry: string;
  call_timeout_ms: number;
  memory_limit_mb: number;
}

/**
 * 创建题目请求体。
 *
 * 注意：`id` 字段已从客户端输入中移除——所有题目统一由服务端生成 UUID。
 * 历史 seed 数据中的字符串 id（如 "1001"）仍可通过 `support_package_storage_url` 关联，
 * 但新题目主键空间完全使用 UUID v4。
 */
export interface CreateProblemInput {
  title: string;
  description: string;
  difficulty?: string;
  judge_image: string;
  judge_command: string;
  support_package_storage_url?: string | null;
  time_limit_ms?: number;
  memory_limit_mb?: number;
  /**
   * 双容器 Runtime 配置。仅 admin 可设置。
   * 设置后 `judge_image` / `judge_command` 仍保留为同步值，但调度时以 runtime_config 为准。
   */
  runtime_config?: RuntimeConfig | null;
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
  support_package_storage_url?: string | null;
  time_limit_ms?: number;
  memory_limit_mb?: number;
  /**
   * 双容器 Runtime 配置。设为 null 即清空（题目回到单容器路径）。
   */
  runtime_config?: RuntimeConfig | null;
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
  support_package_storage_url: string | null;
  /** 是否有已上传的支持包文件 */
  has_support_package: boolean;
  time_limit_ms: number;
  memory_limit_mb: number;
  /**
   * 双容器 Runtime 配置。null 表示单容器题目。
   */
  runtime_config: RuntimeConfig | null;
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
 * 镜像用途分类（dual-container-judge §5）。
 *
 * - `evaluator`：单容器 / 双容器 Evaluator 角色（默认）
 * - `solution`：双容器 Solution 角色
 */
export const JUDGE_IMAGE_KINDS = ["evaluator", "solution"] as const;
export type JudgeImageKind = typeof JUDGE_IMAGE_KINDS[number];

export function isValidJudgeImageKind(value: string): value is JudgeImageKind {
  return JUDGE_IMAGE_KINDS.includes(value as JudgeImageKind);
}

/**
 * 创建评测镜像白名单条目请求体。
 */
export interface CreateJudgeImageInput {
  image: string;
  mode: "exact" | "all_versions";
  /**
   * 镜像用途分类（dual-container-judge §5）。必填：'evaluator' / 'solution'。
   */
  kind: JudgeImageKind;
  description?: string;
}

/**
 * 更新评测镜像白名单条目请求体。
 */
export interface UpdateJudgeImageInput {
  image?: string;
  mode?: "exact" | "all_versions";
  kind?: JudgeImageKind;
  description?: string;
}

/**
 * 评测镜像白名单条目响应。
 */
export interface JudgeImageResponse {
  id: string;
  image: string;
  mode: string;
  /**
   * 镜像用途分类（dual-container-judge §5）。
   */
  kind: JudgeImageKind;
  description: string;
  created_at: string;
  updated_at: string;
}

// ─── 题目导入导出（issue #28）─────────────────────────────────

/**
 * 导出文件格式版本号。
 * v1.0 = 走法 A：仅元数据 + support_package_storage_url 引用 + samples。
 */
export const EXPORT_VERSION = "1.0" as const;

/**
 * 导出单题结构。
 *
 * 字段命名约定：
 * - 蛇形命名（snake_case）保持与 DB 列一致，便于 round-trip
 * - 列表类字段（categories / judge_images / samples）按显示顺序排列
 * - display_id = `${type}${number}`，从 type+number 计算得出，导入时可任选其一
 */
export interface ExportProblem {
  id: string;
  display_id: string;
  type: "U" | "P";
  number: number;
  title: string;
  description: string;
  difficulty: string;
  categories: { name: string; slug: string }[];
  judge_images: string[];
  judge_command: string;
  time_limit_ms: number;
  memory_limit_mb: number;
  support_package_storage_url: string | null;
  /** 引用支持包 URL（与 support_package_storage_url 同值，仅作为语义占位） */
  test_cases_ref: string | null;
  /**
   * 双容器 Runtime 配置。null 表示单容器题目。
   * 旧版导出文件可能缺失该字段，导入时按 null 处理。
   */
  runtime_config: RuntimeConfig | null;
  samples: { input: string; output: string }[];
}

/**
 * 完整导出文件结构。
 */
export interface ExportPayload {
  version: typeof EXPORT_VERSION;
  exported_at: string;
  exported_by: string;
  problems: ExportProblem[];
}

/**
 * 导出查询参数。
 * - ids 与 type 互斥：ids 优先，type 用于批量筛选（U/P 全部）
 * - 都未提供时拒绝（避免误操作全表导出）
 */
export interface ExportQuery {
  ids?: string[];
  type?: "U" | "P";
}

/**
 * 导入策略。
 * - create: 不存在则新建；存在则按 skip 处理（不报错）
 * - overwrite: 不存在则新建；存在则覆盖元数据（type/number 不可变）
 * - skip: 不存在则新建失败；存在则跳过
 */
export type ImportStrategy = "create" | "overwrite" | "skip";

/**
 * 导入单条结果。
 */
export interface ImportItemResult {
  /** 来源 id（ExportProblem.id），便于追踪失败项 */
  id: string;
  display_id: string;
  /** created / updated / skipped / failed */
  action: "created" | "updated" | "skipped" | "failed";
  /** 失败原因（仅 action=failed 时存在） */
  reason?: string;
  /** 写入后服务端 id（skipped 时为已存在题目 id，failed 时不存在） */
  problem_id?: string;
}

/**
 * 导入结果报告。
 */
export interface ImportReport {
  strategy: ImportStrategy;
  total: number;
  created: ImportItemResult[];
  updated: ImportItemResult[];
  skipped: ImportItemResult[];
  failed: ImportItemResult[];
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
      // all_versions：提取两者的基础镜像名（去掉 tag 部分）进行比较
      // 注意 entry.image 本身也可能带 tag（即便语义上 all_versions 含 tag 不合理）
      if (getImageBase(image) === getImageBase(entry.image)) return true;
    }
  }
  return false;
}
