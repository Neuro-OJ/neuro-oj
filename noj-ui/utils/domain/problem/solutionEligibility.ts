/**
 * 题目页「发布题解」入口所需的社区配置子集（字段与 `/community/config` 响应一致）。
 *
 * 独立声明而不从 composable 引入：utils 需能在 Deno 单测中直接类型检查。
 */
export interface SolutionConfig {
  solutions_enabled: boolean;
  read_only: boolean;
  solution_requires_accepted: boolean;
  permissions: Record<string, boolean>;
  /** 赛时社区全局静默（非审核员且存在未结束公开赛）。 */
  contest_silence?: boolean;
}

/** 是否还需要查询「当前用户是否通过本题」：门槛开启且非审核员时才需要。 */
export function needsAcceptedCheck(config: SolutionConfig | null): boolean {
  return !!config?.solution_requires_accepted && !config.permissions.moderate;
}

/**
 * 能否在题目页发布题解（与后端 `/solutions/eligibility` 的 `can_create` 同口径）。
 *
 * 审核员不受通过门槛与只读限制；赛时静默、题解模块关闭或无发帖权限时一律不可发布。
 * `accepted` 为 null 表示尚未查询；需要门槛判定时按「不可发布」处理，避免先显示后消失。
 */
export function canPublishSolution(
  config: SolutionConfig | null,
  accepted: boolean | null,
): boolean {
  if (!config) return false;
  const moderator = !!config.permissions.moderate;
  if (!config.solutions_enabled || config.contest_silence) return false;
  if (config.read_only && !moderator) return false;
  if (!config.permissions.solution && !moderator) return false;
  if (needsAcceptedCheck(config) && accepted !== true) return false;
  return true;
}
