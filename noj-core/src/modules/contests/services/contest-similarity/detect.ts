// 配对检测：分桶、逐对比较、阈值过滤与结果排序（纯函数，不访问数据库）。

import { BadRequestError } from "../../../../shared/base/errors.ts";
import {
  DEFAULT_K,
  DEFAULT_MAX_TOKENS,
  DEFAULT_PAIR_LIMIT,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_WINDOW,
  MAX_SIMILAR_PAIR_LIMIT,
} from "./lexicon.ts";
import { fingerprint } from "./fingerprint.ts";
import { normalizeCode, normalizeCodeBlocks } from "./normalize.ts";
import type {
  DetectSimilarPairsOptions,
  SimilarSubmissionPair,
} from "./types.ts";
import type { SimilarityCandidate } from "./types.ts";

/** 纯函数检测结果（含统计信息）。 */
export interface DetectSimilarPairsResult {
  pairs: SimilarSubmissionPair[];
  /** 命中阈值的总对数（未受 limit 截断）。 */
  total: number;
  /** 参与比较的分桶数（题目 × 语言）。 */
  buckets: number;
  /** 真正参与比较的提交数（归一化后 token 足够、且产生了指纹）。 */
  participating: number;
  /**
   * 取出后**未能参与**比较的提交数（归一化后 token 太少、或指纹为空）。
   *
   * 暴露该计数的理由（评审）：`candidates` 只说明"取了多少行"，不说明
   * "多少行真正被比较"。若二者差距很大而调用方只看 candidates，
   * 会误以为分析覆盖了全部候选。
   */
  skipped: number;
}

/** 解析并校验阈值。 */
export function resolveThreshold(threshold: number | undefined): number {
  if (threshold === undefined) return DEFAULT_SIMILARITY_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new BadRequestError("threshold 必须为大于 0 且不超过 1 的小数");
  }
  return threshold;
}

/** 解析并对齐 limit（0 与负数视为无意义输入，交由调用方校验）。 */
export function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAIR_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new BadRequestError("limit 必须为不小于 1 的整数");
  }
  return Math.min(limit, MAX_SIMILAR_PAIR_LIMIT);
}

/** 保留 4 位小数，避免浮点尾数泄漏到 API 响应。 */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** 分桶键：同一题目 + 同一语言才有比较意义。 */
function bucketKey(candidate: SimilarityCandidate): string {
  return `${candidate.problem_id}\u0000${candidate.language}`;
}

/** 按「较早提交在前」的确定性顺序排列一对候选。 */
function orderPair(
  left: SimilarityCandidate,
  right: SimilarityCandidate,
): [SimilarityCandidate, SimilarityCandidate] {
  const leftAt = left.created_at ?? "";
  const rightAt = right.created_at ?? "";
  if (leftAt !== rightAt) {
    return leftAt < rightAt ? [left, right] : [right, left];
  }
  return left.submission_id <= right.submission_id
    ? [left, right]
    : [right, left];
}

/**
 * 在给定提交集合内找出互相高度相似的提交对（纯函数，不访问数据库）。
 *
 * 流程：按「题目 × 语言」分桶 → 桶内逐对比较指纹 Jaccard → 过滤阈值 →
 * 按相似度降序排序 → 截断到 `limit`。
 *
 * 两点工程取舍：
 * - 分桶而非全量对比：跨题目/跨语言的比较没有意义，分桶同时把 O(n²) 的
 *   常数压下来（n 是最大桶的规模而不是全部候选数）。
 * - 先用指纹数量上界剪枝：Jaccard ≤ min(|A|, |B|) / max(|A|, |B|)，长度
 *   差异过大的对直接跳过，省掉集合求交。
 *
 * 规模控制由调用方负责：本函数只处理已经拿到的数组，防止资源放大的职责在
 * 查询层 `findSimilarSubmissions()`（那里的 `maxSubmissions` 上限才有意义）。
 */
export function detectSimilarPairs(
  submissions: readonly SimilarityCandidate[],
  options: DetectSimilarPairsOptions = {},
): SimilarSubmissionPair[] {
  return collectSimilarPairs(submissions, options).pairs;
}

interface Prepared {
  candidate: SimilarityCandidate;
  globalPrints: ReadonlySet<number>;
  blockPrints: ReadonlySet<number>;
}

interface InvertedMatch {
  i: number;
  j: number;
  score: number;
  shared: number;
  sizeA: number;
  sizeB: number;
}

function matchByInvertedIndex(
  bucket: readonly Prepared[],
  selectPrints: (item: Prepared) => ReadonlySet<number>,
  threshold: number,
  skipSameUser: boolean,
  maxDocFreqRatio?: number,
): InvertedMatch[] {
  const n = bucket.length;
  if (n < 2) return [];

  const postings = new Map<number, number[]>();
  const rawSizes = new Array<number>(n);
  const distinctUsers = new Set<string>();
  for (let i = 0; i < n; i++) {
    const item = bucket[i]!;
    distinctUsers.add(item.candidate.user_id);
    const prints = selectPrints(item);
    rawSizes[i] = prints.size;
    for (const fp of prints) {
      let list = postings.get(fp);
      if (!list) {
        list = [i];
        postings.set(fp, list);
      } else {
        list.push(i);
      }
    }
  }

  const effectiveSizes = rawSizes.slice();
  const applyDfFilter = maxDocFreqRatio !== undefined &&
    Number.isFinite(maxDocFreqRatio) &&
    maxDocFreqRatio > 0 &&
    maxDocFreqRatio < 1 &&
    distinctUsers.size >= 10;
  const maxAllowedDocs = applyDfFilter
    ? Math.max(2, Math.floor(n * maxDocFreqRatio!))
    : n;

  const pairShared = new Map<number, number>();
  for (const list of postings.values()) {
    if (applyDfFilter && list.length > maxAllowedDocs) {
      for (const idx of list) {
        effectiveSizes[idx]!--;
      }
      continue;
    }
    if (list.length < 2) continue;
    for (let a = 0; a < list.length; a++) {
      const i = list[a]!;
      for (let b = a + 1; b < list.length; b++) {
        const j = list[b]!;
        if (
          skipSameUser &&
          bucket[i]!.candidate.user_id === bucket[j]!.candidate.user_id
        ) {
          continue;
        }
        const key = i * n + j;
        pairShared.set(key, (pairShared.get(key) ?? 0) + 1);
      }
    }
  }

  const matches: InvertedMatch[] = [];
  for (const [key, shared] of pairShared.entries()) {
    const i = Math.floor(key / n);
    const j = key % n;
    const sizeA = effectiveSizes[i]!;
    const sizeB = effectiveSizes[j]!;
    if (sizeA <= 0 || sizeB <= 0) continue;
    const smaller = Math.min(sizeA, sizeB);
    const larger = Math.max(sizeA, sizeB);
    if (smaller / larger < threshold) continue;
    const score = similarityFromCounts(shared, sizeA, sizeB);
    if (score < threshold) continue;
    matches.push({ i, j, score, shared, sizeA, sizeB });
  }
  return matches;
}

/** `detectSimilarPairs()` 的带统计实现（服务层复用以生成响应元信息）。 */
export function collectSimilarPairs(
  submissions: readonly SimilarityCandidate[],
  options: DetectSimilarPairsOptions = {},
): DetectSimilarPairsResult {
  const threshold = resolveThreshold(options.threshold);
  const limit = resolveLimit(options.limit);
  const k = options.k ?? DEFAULT_K;
  const window = options.window ?? DEFAULT_WINDOW;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const skipSameUser = options.skipSameUser ?? true;
  const maxDocFreqRatio = options.maxDocFreqRatio;

  const buckets = new Map<string, Prepared[]>();
  let participating = 0;
  for (const candidate of submissions) {
    const tokens = normalizeCode(candidate.code, candidate.language);
    if (tokens.length === 0) continue;
    const sliced = tokens.length > maxTokens
      ? tokens.slice(0, maxTokens)
      : tokens;
    const globalPrints = new Set(fingerprint(sliced, k, window));
    if (globalPrints.size === 0) continue;

    const blocks = normalizeCodeBlocks(candidate.code, candidate.language);
    const blockPrints = new Set<number>();
    let budget = maxTokens;
    for (const block of blocks) {
      if (budget <= 0) break;
      const chunk = block.length > budget ? block.slice(0, budget) : block;
      budget -= chunk.length;
      for (const fp of fingerprint(chunk, k, window)) {
        blockPrints.add(fp);
      }
    }

    participating += 1;
    const key = bucketKey(candidate);
    const bucket = buckets.get(key);
    const prepared: Prepared = { candidate, globalPrints, blockPrints };
    if (bucket) bucket.push(prepared);
    else buckets.set(key, [prepared]);
  }

  const found: SimilarSubmissionPair[] = [];
  for (const bucket of buckets.values()) {
    const n = bucket.length;
    if (n < 2) continue;

    const merged = new Map<
      number,
      InvertedMatch & { strategy: "global" | "block_local" }
    >();
    for (
      const match of matchByInvertedIndex(
        bucket,
        (item) => item.globalPrints,
        threshold,
        skipSameUser,
        maxDocFreqRatio,
      )
    ) {
      merged.set(match.i * n + match.j, { ...match, strategy: "global" });
    }
    for (
      const match of matchByInvertedIndex(
        bucket,
        (item) => item.blockPrints,
        threshold,
        skipSameUser,
        maxDocFreqRatio,
      )
    ) {
      const key = match.i * n + match.j;
      const prev = merged.get(key);
      if (!prev || match.score > prev.score) {
        merged.set(key, { ...match, strategy: "block_local" });
      }
    }

    for (const match of merged.values()) {
      const left = bucket[match.i]!;
      const right = bucket[match.j]!;
      const [first, second] = orderPair(left.candidate, right.candidate);
      const firstIsLeft = first === left.candidate;
      found.push({
        submission_a_id: first.submission_id,
        user_a_id: first.user_id,
        username_a: first.username ?? null,
        submitted_at_a: first.created_at ?? null,
        submission_b_id: second.submission_id,
        user_b_id: second.user_id,
        username_b: second.username ?? null,
        submitted_at_b: second.created_at ?? null,
        problem_id: first.problem_id,
        language: first.language,
        similarity: round4(match.score),
        shared_fingerprints: match.shared,
        fingerprint_count_a: firstIsLeft ? match.sizeA : match.sizeB,
        fingerprint_count_b: firstIsLeft ? match.sizeB : match.sizeA,
        match_strategy: match.strategy,
      });
    }
  }

  found.sort((a, b) =>
    b.similarity - a.similarity ||
    a.submission_a_id.localeCompare(b.submission_a_id) ||
    a.submission_b_id.localeCompare(b.submission_b_id)
  );

  return {
    pairs: found.slice(0, limit),
    total: found.length,
    buckets: buckets.size,
    participating,
    skipped: submissions.length - participating,
  };
}

/** 由交集大小与两侧规模还原 Jaccard（避免二次求交）。 */
function similarityFromCounts(
  shared: number,
  sizeA: number,
  sizeB: number,
): number {
  const union = sizeA + sizeB - shared;
  return union === 0 ? 0 : shared / union;
}
