/**
 * 竞赛防作弊扩展引擎功能切片对外出口（`defineFeature` 自声明）。
 *
 * 包含预测提交向量查重（Cohen's Kappa / 共同错误重合度）与产物 ZIP Python 源码确定性提取。
 */
import { defineFeature } from "../../shared/feature.ts";

export const feature = defineFeature({
  name: "contest-anti-cheat",
});

export {
  comparePredictionVectors,
  detectSimilarPredictions,
  type DetectSimilarPredictionsOptions,
  type PredictionCandidate,
  type PredictionComparisonMetrics,
  type PredictionSimilarityPair,
} from "./prediction.ts";
export {
  DEFAULT_MAX_ARTIFACT_SOURCE_CHARS,
  extractSortablePythonSource,
} from "./artifact-source.ts";
export {
  DEFAULT_MAX_RAW_CODE_CHARS,
  DEFAULT_MAX_SIMILARITY_SUBMISSIONS,
  DEFAULT_SIMILARITY_THRESHOLD,
  MAX_SIMILAR_PAIR_LIMIT,
  MIN_PAIRABLE_CODE_CHARS,
} from "./lexicon.ts";
export { normalizeCode, normalizeCodeBlocks } from "./normalize.ts";
export { fingerprint, type FingerprintSet, similarity } from "./fingerprint.ts";
export {
  collectSimilarPairs,
  detectSimilarPairs,
  resolveLimit,
  resolveThreshold,
} from "./detect.ts";
export type {
  DetectSimilarPairsOptions,
  SimilarityCandidate,
  SimilarSubmissionPair,
} from "./types.ts";
