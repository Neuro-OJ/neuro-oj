/**
 * Evaluator 容器运行时配置。
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
  /** 网络配置（可选，缺省 = 无网；开启后 evaluator 以 bridge 模式联网） */
  network?: {
    enabled: boolean;
  };
}

/**
 * Solution 容器运行时配置。
 */
export interface SolutionRuntime {
  /** Docker 镜像名（须在 `judge_images` 白名单中且 kind='solution'） */
  image: string;
  /** 单次 SDK 调用的时间上限（毫秒），作为调用级超时的题目级默认值（runner.call 可传 timeout_ms 覆盖；capability 可经 register_capability 配置）。单次超时不影响 host 进程 */
  call_timeout_ms: number;
  /** Solution 容器内存上限（MB） */
  memory_limit_mb: number;
}

/**
 * 双容器模式的 Runtime 配置（必填）。
 */
export interface RuntimeConfig {
  evaluator: EvaluatorRuntime;
  solution: SolutionRuntime;
}

/**
 * LLM 评测任务字段：携带 gateway 地址与短期 eval_token。
 */
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

/**
 * 提交的状态枚举。
 */
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
export function isTerminalSubmissionStatus(
  status: SubmissionStatus,
): boolean {
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

/**
 * RBAC 权限名称类型（格式：`resource:action`，如 `"problem:create_p"`）。
 */
export type PermissionName = string;

/**
 * 系统预置权限定义列表。
 * 每个权限包含 resource、action、description，对应 permissions 表。
 */
export const PERMISSION_DEFS: Array<{
  resource: string;
  action: string;
  description: string;
}> = [
  // 管理员全权限通行证（替代 roles.is_admin 语义；权限检查含此权限即视为管理员）
  {
    resource: "admin",
    action: "full_access",
    description: "管理员全权限（隐式拥有所有权限）",
  },
  // 题目
  { resource: "problem", action: "create", description: "创建题目" },
  {
    resource: "problem",
    action: "create_p",
    description: "创建管理题（P 型）",
  },
  { resource: "problem", action: "read", description: "查看题目" },
  { resource: "problem", action: "write_own", description: "编辑自己的题目" },
  { resource: "problem", action: "write_any", description: "编辑任意题目" },
  { resource: "problem", action: "delete_own", description: "删除自己的题目" },
  { resource: "problem", action: "delete_any", description: "删除任意题目" },
  {
    resource: "problem",
    action: "package_manage_own",
    description: "管理自己题目的支持包",
  },
  {
    resource: "problem",
    action: "package_manage_any",
    description: "管理任意题目的支持包",
  },
  {
    resource: "problem",
    action: "field_evaluator_command",
    description: "设置/修改题目评测命令（evaluator.command）",
  },
  {
    resource: "problem",
    action: "field_evaluator_network",
    description: "设置/修改题目评测联网开关（evaluator.network）",
  },
  // 提交
  { resource: "submission", action: "create", description: "创建提交" },
  { resource: "submission", action: "read_own", description: "查看自己的提交" },
  {
    resource: "submission",
    action: "read_all",
    description: "查看所有提交（含代码）",
  },
  { resource: "submission", action: "rejudge", description: "触发重测" },
  // 用户
  { resource: "user", action: "read_profile", description: "查看用户主页" },
  { resource: "user", action: "search", description: "搜索用户" },
  {
    resource: "user",
    action: "manage",
    description: "管理用户（封禁/改角色）",
  },
  // 标签
  { resource: "tag", action: "read", description: "查看标签" },
  {
    resource: "tag",
    action: "manage",
    description: "管理标签（创建/修改/删除/合并）",
  },
  // 竞赛
  { resource: "contest", action: "create", description: "创建竞赛" },
  {
    resource: "contest",
    action: "manage",
    description: "管理任意竞赛（编辑、删除、参与者管理）",
  },
  { resource: "contest", action: "participate", description: "参加竞赛" },
  // 社区内容与互动
  { resource: "community", action: "read", description: "查看社区内容" },
  { resource: "community", action: "create_solution", description: "发布题解" },
  {
    resource: "community",
    action: "create_discussion",
    description: "发布讨论",
  },
  { resource: "community", action: "create_moment", description: "发布动态" },
  { resource: "community", action: "comment", description: "发表评论" },
  { resource: "community", action: "react", description: "点赞和收藏社区内容" },
  { resource: "community", action: "follow", description: "关注社区用户" },
  { resource: "community", action: "report", description: "举报社区内容" },
  // 社区治理
  {
    resource: "community_moderation",
    action: "review",
    description: "审核社区内容",
  },
  {
    resource: "community_moderation",
    action: "hide",
    description: "隐藏或恢复社区内容",
  },
  {
    resource: "community_moderation",
    action: "lock",
    description: "锁定或置顶社区内容",
  },
  {
    resource: "community_moderation",
    action: "sanction",
    description: "管理社区处罚",
  },
  {
    resource: "community_board",
    action: "manage",
    description: "管理社区板块",
  },
  // 题单（training）
  { resource: "training", action: "create", description: "创建题单" },
  { resource: "training", action: "read", description: "查看题单" },
  { resource: "training", action: "read_any", description: "查看任意题单" },
  { resource: "training", action: "write_own", description: "编辑自己的题单" },
  { resource: "training", action: "write_any", description: "编辑任意题单" },
  { resource: "training", action: "delete_own", description: "删除自己的题单" },
  { resource: "training", action: "delete_any", description: "删除任意题单" },
  { resource: "training", action: "publish", description: "将题单设为公开" },
  { resource: "training", action: "pin", description: "置顶题单" },
  // 公告
  { resource: "announcement", action: "manage", description: "管理公告" },
  // 系统
  { resource: "system", action: "settings", description: "系统设置" },
  { resource: "system", action: "judge_images", description: "管理评测镜像" },
  { resource: "system", action: "audit_logs", description: "查看审计日志" },
  { resource: "system", action: "ip_bans", description: "管理 IP 黑名单" },
];
