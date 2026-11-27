// 预测提交向量查重：一致率、Cohen's Kappa 与共同错误重合度（抗高准确率误报）。

import { BadRequestError } from "../../../../shared/base/errors.ts";

/** 参与预测结果查重的提交候选。 */
export interface PredictionCandidate {
  submission_id: string;
  user_id: string;
  problem_id: string;
  predictions: readonly string[];
  created_at?: string | null;
  username?: string | null;
}

/** 一对高度相似的预测提交。 */
export interface PredictionSimilarityPair {
  submission_a_id: string;
  user_a_id: string;
  username_a: string | null;
  submitted_at_a: string | null;
  submission_b_id: string;
  user_b_id: string;
  username_b: string | null;
  submitted_at_b: string | null;
  problem_id: string;
  agreement: number;
  kappa: number;
  wrong_coincidence: number | null;
  compared_count: number;
}

export interface PredictionComparisonMetrics {
  compared_count: number;
  agreement: number;
  kappa: number;
  wrong_coincidence: number | null;
}

export interface DetectSimilarPredictionsOptions {
  /** 触发线索的指标阈值（未传 groundTruth 看 agreement，传了看 wrong_coincidence）。默认 0.85。 */
  threshold?: number;
  limit?: number;
  groundTruth?: readonly string[];
  skipSameUser?: boolean;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * 比较两条预测向量的相似度指标。
 *
 * - `agreement`：逐项完全一致率；
 * - `kappa`：扣除随机分布期望一致率后的 Cohen's Kappa；
 * - `wrong_coincidence`：提供 `groundTruth` 时，双方在真实标签上同时答错且错误输出完全一致的比例（分母为至少一方答错的样本数）。
 */
export function comparePredictionVectors(
  a: readonly string[],
  b: readonly string[],
  groundTruth?: readonly string[],
): PredictionComparisonMetrics {
  const len = Math.min(
    a.length,
    b.length,
    groundTruth?.length ?? Number.MAX_SAFE_INTEGER,
  );
  if (len <= 0) {
    return {
      compared_count: 0,
      agreement: 0,
      kappa: 0,
      wrong_coincidence: groundTruth ? 0 : null,
    };
  }

  let same = 0;
  const freqA = new Map<string, number>();
  const freqB = new Map<string, number>();
  let anyWrong = 0;
  let sharedWrong = 0;

  for (let i = 0; i < len; i++) {
    const va = a[i]!;
    const vb = b[i]!;
    if (va === vb) same++;
    freqA.set(va, (freqA.get(va) ?? 0) + 1);
    freqB.set(vb, (freqB.get(vb) ?? 0) + 1);
    if (groundTruth) {
      const gt = groundTruth[i]!;
      const wrongA = va !== gt;
      const wrongB = vb !== gt;
      if (wrongA || wrongB) {
        anyWrong++;
        if (wrongA && wrongB && va === vb) sharedWrong++;
      }
    }
  }

  const agreement = same / len;
  let expectedRandom = 0;
  for (const [label, countA] of freqA.entries()) {
    const countB = freqB.get(label) ?? 0;
    expectedRandom += (countA / len) * (countB / len);
  }
  const kappa = expectedRandom >= 1
    ? (agreement >= 1 ? 1 : 0)
    : (agreement - expectedRandom) / (1 - expectedRandom);

  return {
    compared_count: len,
    agreement: round4(agreement),
    kappa: round4(kappa),
    wrong_coincidence: groundTruth
      ? round4(anyWrong === 0 ? 0 : sharedWrong / anyWrong)
      : null,
  };
}

/** 按题目分桶检测可疑预测提交对。 */
export function detectSimilarPredictions(
  candidates: readonly PredictionCandidate[],
  options: DetectSimilarPredictionsOptions = {},
): PredictionSimilarityPair[] {
  const threshold = options.threshold ?? 0.85;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new BadRequestError("threshold 必须为大于 0 且不超过 1 的小数");
  }
  const limit = options.limit ?? 50;
  const skipSameUser = options.skipSameUser ?? true;
  const groundTruth = options.groundTruth;

  const byProblem = new Map<string, PredictionCandidate[]>();
  for (const item of candidates) {
    const list = byProblem.get(item.problem_id);
    if (list) list.push(item);
    else byProblem.set(item.problem_id, [item]);
  }

  const pairs: PredictionSimilarityPair[] = [];
  for (const bucket of byProblem.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const left = bucket[i]!;
        const right = bucket[j]!;
        if (skipSameUser && left.user_id === right.user_id) continue;
        const metrics = comparePredictionVectors(
          left.predictions,
          right.predictions,
          groundTruth,
        );
        if (metrics.compared_count === 0) continue;
        const score = groundTruth
          ? (metrics.wrong_coincidence ?? 0)
          : metrics.agreement;
        if (score < threshold) continue;
        const [first, second] =
          (left.created_at ?? "") <= (right.created_at ?? "")
            ? [left, right]
            : [right, left];
        pairs.push({
          submission_a_id: first.submission_id,
          user_a_id: first.user_id,
          username_a: first.username ?? null,
          submitted_at_a: first.created_at ?? null,
          submission_b_id: second.submission_id,
          user_b_id: second.user_id,
          username_b: second.username ?? null,
          submitted_at_b: second.created_at ?? null,
          problem_id: first.problem_id,
          agreement: metrics.agreement,
          kappa: metrics.kappa,
          wrong_coincidence: metrics.wrong_coincidence,
          compared_count: metrics.compared_count,
        });
      }
    }
  }

  pairs.sort((a, b) => {
    const scoreA = a.wrong_coincidence ?? a.agreement;
    const scoreB = b.wrong_coincidence ?? b.agreement;
    return scoreB - scoreA ||
      b.agreement - a.agreement ||
      a.submission_a_id.localeCompare(b.submission_a_id);
  });
  return pairs.slice(0, limit);
}
