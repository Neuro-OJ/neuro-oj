// 指纹与相似度：哈希、k-gram、winnowing 指纹、Jaccard 相似度。

import { BadRequestError } from "../../../../shared/base/errors.ts";
import { DEFAULT_K, DEFAULT_WINDOW } from "./lexicon.ts";

/** 32 位 FNV-1a，用于把 token 字符串压成定长数值。 */
function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash = Math.imul(hash ^ token.charCodeAt(i), 16777619) >>> 0;
  }
  return hash;
}

/**
 * 计算第 `start` 个 token 起始的 k-gram 指纹值。
 *
 * 组合两个 32 位哈希（FNV-1a 与 djb2）成 ≤ 2^53-1 的整数：单用 32 位时
 * 按生日界估算，数十万指纹量级下会有可观碰撞，从而把无关提交的相似度
 * 略微抬高；组合后碰撞概率可忽略，同时保持数字键的集合运算速度。
 */
function hashKGram(
  hashes: readonly number[],
  start: number,
  k: number,
): number {
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let i = start; i < start + k; i++) {
    const value = hashes[i]!;
    fnv = Math.imul(fnv ^ value, 16777619) >>> 0;
    djb = (Math.imul(djb, 33) ^ value) >>> 0;
  }
  // 2^32-1 左移 21 位后仍小于 Number.MAX_SAFE_INTEGER，无精度损失。
  return fnv * 2097152 + (djb >>> 11);
}

/**
 * winnowing 指纹：对 token 流取 k-gram 哈希，再在每个长度 w 的滑动窗口内
 * 保留最小哈希（同值取最右，与论文一致）。
 *
 * 该选择策略给出论文中的保证：两份代码若存在长度 ≥ k + w - 1 的公共
 * token 片段，则其指纹集合必有交集——这正是「改写变量名后仍能命中」的
 * 理论基础。窗口最小值用单调队列维护，整体 O(n)。
 *
 * @param tokens 规范 token 序列（`normalizeCode()` 的输出）。
 * @param k k-gram 长度，默认 5，必须 ≥ 1。
 * @param window 窗口长度，默认 4，必须 ≥ 1。
 * @returns 去重后的指纹值数组；token 数 < k（或 < window）时按论文取全局
 *   最小哈希作为唯一指纹；无可用 k-gram 时返回空数组。
 */
export function fingerprint(
  tokens: readonly string[],
  k: number = DEFAULT_K,
  window: number = DEFAULT_WINDOW,
): number[] {
  if (!Number.isInteger(k) || k < 1) {
    throw new BadRequestError("k 必须为不小于 1 的整数");
  }
  if (!Number.isInteger(window) || window < 1) {
    throw new BadRequestError("window 必须为不小于 1 的整数");
  }
  const gramCount = tokens.length - k + 1;
  if (gramCount <= 0) return [];
  const tokenHashes = tokens.map(hashToken);
  const gramHashes: number[] = new Array(gramCount);
  for (let i = 0; i < gramCount; i++) {
    gramHashes[i] = hashKGram(tokenHashes, i, k);
  }
  const effectiveWindow = Math.min(window, gramCount);
  const selected = new Set<number>();
  const queue: number[] = [];
  for (let i = 0; i < gramCount; i++) {
    const current = gramHashes[i]!;
    // `>=` 让同值哈希保留最右侧下标，与论文的 tie-break 一致。
    while (
      queue.length > 0 && gramHashes[queue[queue.length - 1]!]! >= current
    ) {
      queue.pop();
    }
    queue.push(i);
    if (queue[0]! <= i - effectiveWindow) queue.shift();
    if (i >= effectiveWindow - 1) selected.add(gramHashes[queue[0]!]!);
  }
  return [...selected];
}

/** 相似度计算可接受的指纹集合形态。 */
export type FingerprintSet = readonly number[] | ReadonlySet<number>;

/** 把数组形态的指纹转成集合（已是集合则原样返回）。 */
function toFingerprintSet(value: FingerprintSet): ReadonlySet<number> {
  return value instanceof Set ? value : new Set(value);
}

/**
 * 两个指纹集合的 Jaccard 相似度：|A ∩ B| / |A ∪ B|。
 *
 * 任一侧为空集合时返回 0（而不是 1）：空指纹代表「代码为空/过短，无法
 * 比较」，若返回 1 会让所有空提交互判 100% 相似，制造大量假线索。
 * 计算时遍历较小集合，复杂度 O(min(|A|, |B|))。
 */
export function similarity(a: FingerprintSet, b: FingerprintSet): number {
  const setA = toFingerprintSet(a);
  const setB = toFingerprintSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let shared = 0;
  for (const value of small) {
    if (large.has(value)) shared++;
  }
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}
