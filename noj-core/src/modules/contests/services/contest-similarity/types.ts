// 共享类型：相似度候选提交、相似提交对与检测选项。

/** 参与相似度计算的提交（由查询层或测试直接构造）。 */
export interface SimilarityCandidate {
  /** 对外提交标识（`submissions.public_id`）。 */
  submission_id: string;
  user_id: string;
  problem_id: string;
  language: string;
  /** 源代码；`null`/空串代表无法比较（会被跳过）。 */
  code: string | null;
  /** 可选的提交时间（ISO 8601），用于确定 A/B 先后与展示。 */
  created_at?: string | null;
  /** 可选的提交者用户名，仅用于展示。 */
  username?: string | null;
}

/** 一对高度相似的提交。 */
export interface SimilarSubmissionPair {
  /** 较早提交的一方（`created_at` 缺失时按提交标识排序）。 */
  submission_a_id: string;
  user_a_id: string;
  username_a: string | null;
  submitted_at_a: string | null;
  submission_b_id: string;
  user_b_id: string;
  username_b: string | null;
  submitted_at_b: string | null;
  problem_id: string;
  language: string;
  /** Jaccard 相似度，保留 4 位小数；阈值比较使用未舍入的原值。 */
  similarity: number;
  /** 公共指纹数 / 两侧指纹数：供人工判断证据强度。 */
  shared_fingerprints: number;
  fingerprint_count_a: number;
  fingerprint_count_b: number;
}

/** `detectSimilarPairs()` 的可选项。 */
export interface DetectSimilarPairsOptions {
  /** 相似度阈值，取值 (0, 1]，默认 0.8。 */
  threshold?: number;
  /** 返回的对数上限，默认 50；超出部分按相似度降序截断。 */
  limit?: number;
  /** k-gram 长度，默认 5。 */
  k?: number;
  /** winnowing 窗口，默认 4。 */
  window?: number;
  /** 单份提交参与分析的 token 上限，默认 6000。 */
  maxTokens?: number;
  /** 是否跳过「同一用户的两次提交」配对，默认 true。 */
  skipSameUser?: boolean;
}
