type ContestType = 'kaggle' | 'oi' | 'ioi' | 'ioi_strict' | 'acm';
type RankingVisibility = 'public' | 'participants' | 'hidden';
interface ContestConfig {
  penalty_minutes?: number;
  scoreboard_scope?: 'self' | 'full';
  submission_limits?: Record<string, number>;
}
export const DOMAIN_CONTEST_TYPES = [
  { value: 'kaggle', label: 'Kaggle', description: 'AI 题和客观题；AI 每题最高分，客观题原分直接相加。' },
  { value: 'oi', label: 'OI', description: 'OI 题和客观题；每题最后提交，赛时隐藏结果和成绩榜。' },
  { value: 'ioi', label: 'IOI', description: 'OI 题；每题最后提交，展示测试点与子任务结果和实时榜。' },
  { value: 'ioi_strict', label: 'IOI 严格', description: 'OI 题；每题最后提交，只展示汇总判定和分数。' },
  { value: 'acm', label: 'ACM/ICPC', description: 'OI 题；首次 AC 与此前失败罚时，支持封榜。' },
] as const;
/** 赛前默认值；发布后规则由服务器锁定。 */
export function domainContestDefaults(
  type: ContestType,
): { config: ContestConfig; ranking_visibility: RankingVisibility; freeze_duration_seconds: number } {
  return {
    config: type === 'kaggle' ? { scoreboard_scope: 'self' } : type === 'acm' ? { penalty_minutes: 20 } : {},
    ranking_visibility: type === 'oi' ? 'hidden' : 'participants',
    freeze_duration_seconds: type === 'acm' ? 3600 : 0,
  };
}
/**
 * 组装域内竞赛表单提交的 `config`。
 *
 * 表单只编辑罚时与榜单范围；后端会整体替换 `config`，因此必须带上已有的
 * `submission_limits`（由管理后台设置），否则在域内编辑一次就会清空提交次数限制。
 */
export function domainContestConfig(
  type: ContestType,
  fields: { penalty_minutes: number; scoreboard_scope: 'self' | 'full' },
  existing?: ContestConfig,
): ContestConfig {
  const config: ContestConfig = type === 'acm'
    ? { penalty_minutes: fields.penalty_minutes }
    : type === 'kaggle'
    ? { scoreboard_scope: fields.scoreboard_scope }
    : {};
  if (existing?.submission_limits) config.submission_limits = { ...existing.submission_limits };
  return config;
}
export function domainContestAllows(type: ContestType, kind: 'ai' | 'oi' | 'objective') {
  return type === 'kaggle' ? kind !== 'oi' : type === 'oi' ? kind !== 'ai' : kind === 'oi';
}
export function contestPenaltyText(milliseconds: number) {
  return `${Math.floor(milliseconds / 60000)} 分钟`;
}
