/**
 * 题目统一视图模型（#511）。
 *
 * 背景：独立题目页（`/problems/:id`）与竞赛做题页
 * （`/contests/:contestId/problems/:label`）各自维护了一份题面/头部渲染，
 * 且后端返回的资源形状不同（`Problem` vs `ContestProblem`）。两份实现已开始分叉
 * （竞赛页另建了一套硬编码难度色）。
 *
 * 本模块把两种资源归一为 `ProblemView`，让 `components/problem/*` 只需面对一种形状；
 * 放在 `utils/` 而非组件内，是因为本仓库约定**纯逻辑放 utils**，可被 `deno task test`
 * 直接断言（与 `utils/problemStats.ts`、`utils/submissionFormat.ts` 一致）。
 */

/** 题目标签（`kind='problem'` 可点击筛选；`kind='algorithm'` 通过后可见）。 */
export interface ProblemTagView {
  id: string;
  name: string;
  kind: 'problem' | 'algorithm';
}

/** 关联到题目的、尚未结束的公开赛（仅题目所有者与管理员可见）。 */
export interface ProblemContestSecrecyNotice {
  /** 竞赛公开 ID（`ct-…`），用于构造竞赛首页链接。 */
  public_id: string;
  /** 竞赛标题。 */
  title: string;
}

/** 独立题目与竞赛题目共用的展示视图。 */
export interface ProblemView {
  /** 内部 UUID（竞赛题为 `problem_id`），用于提交与关联查询。 */
  id: string;
  /** 公开编号（如 `P1000`、竞赛标签 `A`）。 */
  display_id: string;
  title: string;
  description: string;
  samples?: import('./oiWorkspace.ts').ProblemSample[];
  difficulty: string;
  /** 题型：`U` 用户题库 / `T` 主题库。竞赛页无该字段，默认主题库。 */
  type: string;
  /** 是否客观题（即时判定，无评测容器）。 */
  is_objective: boolean;
  /** 评测题型与公开后端标识；不依赖仅管理员可见的运行配置。 */
  judge_type?: 'dual' | 'oi';
  judge_backend?: 'dual' | 'oi-native' | 'oi-wasm' | null;
  /** 提交模式：`code` 代码 / `artifact` 产物 zip。 */
  submission_mode: 'code' | 'artifact';
  /** artifact 单文件大小上限（MB）；null 表示使用平台默认上限。 */
  artifact_max_size_mb: number | null;
  /** 出题人用户名（仅用户题库有值）。 */
  owner_username: string | null;
  /** 出题人头像 URL；null 表示未上传或来源不提供。 */
  owner_avatar_url: string | null;
  owner_id: string | null;
  /**
   * 关联的、尚未结束的公开赛（仅题目所有者与管理员能收到该字段）。
   *
   * 非空表示该题已加入公开赛：除所有者与管理员外所有人访问题目相关页面/接口都会
   * 404，竞赛结束后自动恢复可见。页面据此渲染保密提示横幅。
   */
  contest_secrecy: ProblemContestSecrecyNotice[];
  /** 时间限制（ms）；null 表示该来源不提供（竞赛页无 runtime_config）。 */
  time_limit_ms: number | null;
  /** 内存限制（MB）；null 同上。 */
  memory_limit_mb: number | null;
  tags: ProblemTagView[];
  /** 是否存在当前不可见的算法标签（通过本题后可见）。 */
  has_hidden_algorithm_tags: boolean;
  /**
   * 作答版本（Handbook §4.1/§4.2）。
   *
   * 独立题目页：题库有效策略解析出的默认作答版本；竞赛页：该竞赛固定版本。
   * 提交必须原样回传——服务端据此判断"在评测哪一版"，不携带会被 409 拒绝。
   * `null` 表示题目尚未发布任何版本（此时不能提交）。
   */
  version_id: string | null;
  /** 作答版本的版本号（展示用）。 */
  version: number | null;
  /** 最新已发布版本 ID（独立题目页；竞赛页为 null）。 */
  latest_version_id: string | null;
  /** 最新已发布版本号。 */
  latest_version: number | null;
  /** 题库有效版本策略（竞赛页为 null：竞赛策略独立于题库）。 */
  effective_version_policy:
    | { mode: 'any' }
    | { mode: 'exact'; version_id: string | null }
    | null;
  /** 当前作答版本是否就是最新版。 */
  is_latest: boolean;
}

/** `GET /api/v1/problems/:id` 的 data 形状。 */
export interface ProblemResource {
  id: string;
  display_id: string;
  title: string;
  description: string;
  samples?: import('./oiWorkspace.ts').ProblemSample[];
  difficulty: string;
  type: string;
  owner_id: string;
  owner_username?: string;
  owner_avatar_url?: string | null;
  is_objective: boolean;
  judge_type?: 'dual' | 'oi';
  judge_backend?: 'dual' | 'oi-native' | 'oi-wasm' | null;
  submission_mode?: 'code' | 'artifact';
  artifact_max_size_mb?: number | null;
  tags?: ProblemTagView[];
  has_hidden_algorithm_tags?: boolean;
  /** 关联的未结束公开赛；仅所有者/管理员会收到（保密提示横幅）。 */
  contest_secrecy?: ProblemContestSecrecyNotice[] | null;
  /** 作答版本（题库策略解析；未发布为 null）。 */
  version_id?: string | null;
  version?: number | null;
  latest_version_id?: string | null;
  latest_version?: number | null;
  effective_version_policy?:
    | { mode: 'any' }
    | { mode: 'exact'; version_id: string | null };
  is_latest?: boolean;
  runtime_config?: {
    evaluator?: {
      time_limit_ms?: number;
      memory_limit_mb?: number;
    };
  };
}

/** `GET /api/v1/contests/:contestId/problems/:label` 的 data 形状。 */
export interface ContestProblemResource {
  problem_id: string;
  display_id: string;
  title: string;
  description: string;
  samples?: import('./oiWorkspace.ts').ProblemSample[];
  difficulty: string;
  submission_mode?: 'code' | 'artifact';
  artifact_max_size_mb?: number | null;
  is_objective?: boolean;
  judge_type?: 'dual' | 'oi';
  judge_backend?: 'dual' | 'oi-native' | 'oi-wasm' | null;
  /** 竞赛固定作答版本；提交必须原样回传（不一致 → 409）。 */
  version_id?: string | null;
  version?: number | null;
}

/** 独立题目资源 → 视图。 */
export function toProblemView(resource: ProblemResource): ProblemView {
  const evaluator = resource.runtime_config?.evaluator;
  return {
    id: resource.id,
    display_id: resource.display_id,
    title: resource.title,
    description: resource.description,
    samples: resource.samples ?? [],
    difficulty: resource.difficulty,
    type: resource.type,
    is_objective: resource.is_objective === true,
    judge_type: resource.judge_type,
    judge_backend: resource.judge_backend ?? null,
    submission_mode: resource.submission_mode ?? 'code',
    artifact_max_size_mb: resource.artifact_max_size_mb ?? null,
    owner_username: resource.owner_username ?? null,
    owner_avatar_url: resource.owner_avatar_url ?? null,
    owner_id: resource.owner_id ?? null,
    time_limit_ms: evaluator?.time_limit_ms ?? null,
    memory_limit_mb: evaluator?.memory_limit_mb ?? null,
    tags: resource.tags ?? [],
    has_hidden_algorithm_tags: resource.has_hidden_algorithm_tags === true,
    contest_secrecy: resource.contest_secrecy ?? [],
    version_id: resource.version_id ?? null,
    version: resource.version ?? null,
    latest_version_id: resource.latest_version_id ?? null,
    latest_version: resource.latest_version ?? null,
    effective_version_policy: resource.effective_version_policy ?? null,
    is_latest: resource.is_latest === true,
  };
}

/**
 * 竞赛题目资源 → 视图。
 *
 * 竞赛接口不返回 `type`/`runtime_config`/`tags`/`owner_username`：
 * - `type` 固定为主题库（竞赛题目由平台维护）；
 * - 时限/内存以 `null` 表达"未知"，让头部统计条隐藏对应项，
 *   而不是用 `0` 顶替（`0ms` 会被误读为真实限制）。
 */
export function toContestProblemView(
  resource: ContestProblemResource,
): ProblemView {
  return {
    id: resource.problem_id,
    display_id: resource.display_id,
    title: resource.title,
    description: resource.description,
    samples: resource.samples ?? [],
    difficulty: resource.difficulty,
    type: 'T',
    // 后端 ContestProblemResponse 目前可能不返回该字段，故只认显式 true
    is_objective: resource.is_objective === true,
    judge_type: resource.judge_type,
    judge_backend: resource.judge_backend ?? null,
    submission_mode: resource.submission_mode ?? 'code',
    artifact_max_size_mb: resource.artifact_max_size_mb ?? null,
    owner_username: null,
    owner_avatar_url: null,
    owner_id: null,
    time_limit_ms: null,
    memory_limit_mb: null,
    tags: [],
    has_hidden_algorithm_tags: false,
    // 竞赛页本身就是"已在竞赛内"的视图，不渲染保密提示
    contest_secrecy: [],
    // 竞赛题目按竞赛固定版本（pinned_version_id）作答，与题库有效策略无关；
    // 竞赛接口不返回 latest_version_*，故 is_latest 恒为 false——
    // 前端只在 latest_version != null 时渲染"是否有更新版本"提示。
    version_id: resource.version_id ?? null,
    version: resource.version ?? null,
    latest_version_id: null,
    latest_version: null,
    effective_version_policy: null,
    is_latest: false,
  };
}

/** 题型展示文案。 */
export function problemTypeLabel(type: string | undefined): string {
  return type === 'U' ? '用户题库' : '主题库';
}

/** 评测题型文案；不将缺失题型的旧响应误判为 AI 题。 */
export function problemJudgeTypeLabel(
  problem: Pick<ProblemView, 'is_objective' | 'judge_type'>,
): string | null {
  if (problem.is_objective) return '客观题';
  if (problem.judge_type === 'oi') return 'OI 题';
  return problem.judge_type === 'dual' ? 'AI 题' : null;
}

/** 时间限制展示文案；无该来源时为全角破折号占位。 */
export function formatTimeLimit(ms: number | null): string {
  return ms == null ? '—' : `${ms}ms`;
}

/** 内存限制展示文案；无该来源时为全角破折号占位。 */
export function formatMemoryLimit(mb: number | null): string {
  return mb == null ? '—' : `${mb}MB`;
}
