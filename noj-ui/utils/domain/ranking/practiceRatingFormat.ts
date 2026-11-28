import type { PracticeRatingTier } from '../../generated/api-contracts.ts';

/** 练习能力值段位展示元数据（遵循 Precision Instrument 语义色系）。 */
export interface PracticeRatingTierMeta {
  label: string;
  badgeClass: string;
  scoreClass: string;
}

const TIER_META: Record<PracticeRatingTier, PracticeRatingTierMeta> = {
  unrated: {
    label: '未定级',
    badgeClass: 'bg-bg-sunken text-text-muted border border-border',
    scoreClass: 'text-text-muted',
  },
  novice: {
    label: '初阶',
    badgeClass: 'bg-bg-sunken text-text-secondary border border-border',
    scoreClass: 'text-text',
  },
  apprentice: {
    label: '进阶',
    badgeClass: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
    scoreClass: 'text-emerald-700',
  },
  proficient: {
    label: '熟练',
    badgeClass: 'bg-primary-bg text-primary border border-sky-200',
    scoreClass: 'text-primary',
  },
  expert: {
    label: '专精',
    badgeClass: 'bg-indigo-50 text-indigo-700 border border-indigo-200',
    scoreClass: 'text-indigo-700',
  },
  master: {
    label: '大师',
    badgeClass: 'bg-amber-50 text-amber-700 border border-amber-200',
    scoreClass: 'text-amber-700',
  },
  grandmaster: {
    label: '宗师',
    badgeClass: 'bg-rose-50 text-rose-700 border border-rose-200',
    scoreClass: 'text-rose-700',
  },
};

/** 获取练习能力值段位文案与样式。 */
export function getPracticeRatingTierMeta(tier: PracticeRatingTier | string): PracticeRatingTierMeta {
  if (tier in TIER_META) {
    return TIER_META[tier as PracticeRatingTier];
  }
  return TIER_META.unrated;
}

/** 格式化得分率（0–1 → 百分比字符串，保留 1 位小数）。 */
export function formatPracticeScoreRatio(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0.0%';
  const pct = Math.min(100, Math.max(0, ratio * 100));
  return `${pct.toFixed(1)}%`;
}

/** 格式化单题得分 / 满分（API 统一按 ×100 整数存储）。 */
export function formatPracticeEntryScore(bestScore: number, fullScore: number): string {
  const best = (bestScore / 100).toFixed(1);
  const full = fullScore % 100 === 0 ? String(fullScore / 100) : (fullScore / 100).toFixed(1);
  return `${best} / ${full}`;
}

/** 格式化难度数值与来源提示。 */
export function formatEffectiveDifficulty(effectiveDifficulty: number, isCalibrated: boolean): string {
  return `d=${Math.round(effectiveDifficulty)} · ${isCalibrated ? '校准' : '先验'}`;
}

/** 根据已收录题数与 B30 门槛分生成推分引导文案。 */
export function formatPracticeProgressHint(
  countedProblems: number,
  topN: number,
  floorRating: number | null,
): string {
  if (countedProblems === 0) {
    return '在官方主域公开题库获得有效得分后即可生成能力值';
  }
  if (floorRating !== null && countedProblems >= topN) {
    return `当前 B${topN} 门槛 ${floorRating} 分，单题超过此分或刷新 B${topN} 内最高分即可涨分`;
  }
  return `已收录 ${countedProblems}/${topN} 题，继续完成官方公开题库题目可直接累计能力值`;
}
