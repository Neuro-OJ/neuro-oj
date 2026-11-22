/**
 * 竞赛代码相似度检测（防作弊线索发现）。
 *
 * ## 为什么独立成文件
 *
 * `contest-anti-cheat.ts` 原先处理「来源 IP → 账号关联」（已随审计 VULN-06
 * 下线，现仅保留竞赛存在性断言），本文件处理「源代码 → 结构相似度」：算法部分是
 * 纯函数（不碰数据库），独立成文件便于单独单测，也避免把数百行 token
 * 处理逻辑塞进风控共享文件。
 *
 * ## 算法
 *
 * token 归一化 → winnowing 指纹 → Jaccard 相似度，即 MOSS 一类的
 * 「结构近似」检测，而不是语义等价检测：
 *
 * 1. `normalizeCode()`：剥注释与字符串字面量 → 分词 → 标识符按首次出现
 *    顺序改写为 `v1..vN`（语言关键字与高频标准库符号除外）。
 * 2. `fingerprint()`：对 token 流取 k-gram 哈希，再用 winnowing 选出每个
 *    长度为 w 的窗口内最小的哈希作为指纹（Schleimer/Wilkerson/Aiken 2003）。
 * 3. `similarity()`：两个指纹集合的 Jaccard 系数。
 *
 * 不使用 AST：本功能只需要「找出值得人工复核的提交对」，不需要精确到语法
 * 结构；纯 TS 实现零第三方依赖、对竞赛中临时启用的语言也能工作，且对改名、
 * 注释、空白鲁棒。取舍与已知边界见 `normalizeCode()` 的注释。
 *
 * ## 输出口径
 *
 * 只输出「互相高度相似的提交对」作为人工复核线索：不做自动判罚、不返回
 * 源代码本身（只返回提交标识、用户、题目、语言、相似度与指纹统计）。
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { submissions, users } from "../../../shared/db/schema.ts";
import { assertContestExists } from "./contest-anti-cheat.ts";
import {
  DEFAULT_MAX_RAW_CODE_CHARS,
  DEFAULT_MAX_SIMILARITY_SUBMISSIONS,
  MIN_PAIRABLE_CODE_CHARS,
} from "./contest-similarity/lexicon.ts";
import { collectSimilarPairs } from "./contest-similarity/detect.ts";
import type {
  SimilarityCandidate,
  SimilarSubmissionPair,
} from "./contest-similarity/types.ts";

import { BadRequestError } from "../../../shared/base/errors.ts";
import { resolveLimit, resolveThreshold } from "./contest-similarity/detect.ts";

// 算法与纯函数拆在同目录 `contest-similarity/` 下，此处仅保留查询入口与门面导出。
export {
  DEFAULT_SIMILARITY_THRESHOLD,
  MAX_SIMILAR_PAIR_LIMIT,
} from "./contest-similarity/lexicon.ts";
export { normalizeCode } from "./contest-similarity/normalize.ts";
export { fingerprint, similarity } from "./contest-similarity/fingerprint.ts";
export { detectSimilarPairs } from "./contest-similarity/detect.ts";
export type {
  DetectSimilarPairsOptions,
  SimilarityCandidate,
  SimilarSubmissionPair,
} from "./contest-similarity/types.ts";
export type { FingerprintSet } from "./contest-similarity/fingerprint.ts";

/** `findSimilarSubmissions()` 的可选项。 */
export interface FindSimilarSubmissionsOptions {
  /** 相似度阈值，取值 (0, 1]，默认 0.8。 */
  threshold?: number;
  /** 返回的对数上限，默认 50，硬上限 200。 */
  limit?: number;
  /** 仅分析该题目（内部 UUID，由路由层解析标识）；不传表示整个竞赛。 */
  problemId?: string;
  /**
   * 参与计算的提交数上限，默认 200（见 DEFAULT_MAX_SIMILARITY_SUBMISSIONS
   * 的实测依据）；超出即报错而不是静默截断。
   */
  maxSubmissions?: number;
  /** k-gram 长度，默认 5。 */
  k?: number;
  /** winnowing 窗口，默认 4。 */
  window?: number;
  /**
   * 单份提交参与分析的 token 上限，默认 6000（见 DEFAULT_MAX_TOKENS）。
   *
   * 修复（评审）：该选项此前只在内部 `DetectSimilarPairsOptions` 上声明，
   * 而服务层从未把它转发下去——调用方"以为能调"却完全无效。
   * 现在在服务层暴露并真正接线。
   */
  maxTokens?: number;
}

/** `findSimilarSubmissions()` 的返回值。 */
export interface ContestSimilarSubmissionsResult {
  /** 按相似度降序的相似提交对。 */
  data: SimilarSubmissionPair[];
  /** 命中阈值的总对数（未受 limit 截断）。 */
  total: number;
  /** 是否因 limit 截断。 */
  truncated: boolean;
  /** 取出的候选提交数（**不等于**真正被比较的数量，见 participating）。 */
  candidates: number;
  /** 真正参与比较的提交数（归一化后 token 足够且产生了指纹）。 */
  participating: number;
  /** 取出但未能参与比较的提交数（过短 / 归一化后无 token）。 */
  skipped: number;
  /** 实际参与比较的分桶数（题目 × 语言）。 */
  buckets: number;
  /** 生效的阈值。 */
  threshold: number;
  /** 本次生效的返回对数上限。 */
  limit: number;
  /** 本次生效的提交数上限。 */
  max_submissions: number;
}

/**
 * 查询某场竞赛内互相高度相似的提交对。
 *
 * ## 取数口径
 *
 * 只取「普通代码提交」：`status = 'finished'`（评测终态，排除排队中/失败的
 * 噪声）、`artifact_storage_url IS NULL`（artifact 提交的 `code` 恒为空串，
 * 是产物而非源码，纳入只会产生空指纹）、代码去除空白后非空。
 * 同时用 SQL `substr` 只取源码前若干字符，避免把整场竞赛的代码都读进内存。
 *
 * ## 规模限制（为什么报错而不是截断）
 *
 * 相似度检测是 O(n²) 的逐对比较，必须给规模设上限。超限时**抛
 * BadRequestError**（附 `candidates` / `max_submissions` 与缩小范围的建议），
 * 而不是静默只算前 N 条：静默截断会让管理员把「没算到」误读成「没有相似
 * 提交」，而漏检在防作弊场景里的代价远高于一次明确报错。需要覆盖大场次时，
 * 用 `problemId` 逐题分析即可把规模降到上限内（默认上限的实测依据见
 * DEFAULT_MAX_SIMILARITY_SUBMISSIONS）。
 *
 * @param contestId 竞赛内部 UUID（路由层已解析标识）。
 * @param options 阈值、条数上限、题目过滤与规模上限。
 * @throws BadRequestError 参数非法，或候选提交数超过 `maxSubmissions`。
 * @throws NotFoundError 竞赛不存在。
 */
export async function findSimilarSubmissions(
  contestId: string,
  options: FindSimilarSubmissionsOptions = {},
): Promise<ContestSimilarSubmissionsResult> {
  await assertContestExists(contestId);
  const threshold = resolveThreshold(options.threshold);
  const limit = resolveLimit(options.limit);
  const maxSubmissions = Math.max(
    2,
    Math.floor(options.maxSubmissions ?? DEFAULT_MAX_SIMILARITY_SUBMISSIONS),
  );
  const conditions = [
    eq(submissions.contest_id, contestId),
    eq(submissions.status, "finished"),
    isNull(submissions.artifact_storage_url),
    // 空代码 / 纯空白代码：不能用 `length(btrim(code)) > 0`——`btrim()` 默认
    // 只去空格，`"\n"`、`"\t"` 会被判为「有代码」，凭空占用规模额度。
    sql`${submissions.code} !~ '^[[:space:]]*$'`,
    // 可比较性下限（评审修复）：候选上限必须只统计**真正能被比较**的提交。
    //
    // 原实现按 created_at 取 maxSubmissions 条**原始行**，之后才在
    // collectSimilarPairs 里丢弃「归一化后 token 太少」的提交。于是
    // 「原始行数 ≤ 上限、但其中大量是 print(1) 式调试提交」的题目会把额度耗在
    // 垃圾上，真正的雷同对可能落在窗口之外，而响应只报告 truncated=false /
    // total=0，与「确实没有雷同」无法区分——这正是本设计对 >200 场景刻意避免的
    // 误读，却没避免这个场景。
    //
    // SQL 侧无法运行完整归一化（剥注释/字符串、位置化改写），但能挡住最主要的一
    // 类：过短的提交。下界取 k+window-1（=8）的保守倍数，避免误排除「短但结构
    // 完整」的合法解法。
    sql`length(btrim(${submissions.code})) >= ${MIN_PAIRABLE_CODE_CHARS}`,
  ];
  if (options.problemId) {
    conditions.push(eq(submissions.problem_id, options.problemId));
  }
  const db = getDb();
  const rows = await db.select({
    submission_id: submissions.public_id,
    user_id: submissions.user_id,
    username: users.username,
    problem_id: submissions.problem_id,
    language: submissions.language,
    created_at: submissions.created_at,
    // 只取前 DEFAULT_MAX_RAW_CODE_CHARS 个字符：相似度是线索发现，
    // 结构特征在开头已充分体现，避免整场代码全量入内存。
    code: sql<
      string
    >`substr(${submissions.code}, 1, ${DEFAULT_MAX_RAW_CODE_CHARS})`,
  }).from(submissions)
    .innerJoin(users, eq(users.id, submissions.user_id))
    .where(and(...conditions))
    .orderBy(asc(submissions.created_at))
    // 多取 1 条用于判定超限：比「先 COUNT 再查询」少一次往返，也没有竞态。
    .limit(maxSubmissions + 1);

  if (rows.length > maxSubmissions) {
    throw new BadRequestError(
      `候选提交数超过相似度检测上限（${maxSubmissions}），请使用 problem_id 逐题分析以缩小范围`,
      "SIMILARITY_SCALE_EXCEEDED",
      { candidates: rows.length, max_submissions: maxSubmissions },
    );
  }

  const candidates: SimilarityCandidate[] = rows.map((row) => ({
    submission_id: row.submission_id,
    user_id: row.user_id,
    username: row.username,
    problem_id: row.problem_id,
    language: row.language,
    created_at: row.created_at,
    code: row.code,
  }));
  const result = collectSimilarPairs(candidates, {
    threshold,
    limit,
    k: options.k,
    window: options.window,
    // 修复（评审）：maxTokens 此前在选项类型里声明、也写进了 JSDoc，却从未转发到
    // collectSimilarPairs —— 传了等于静默无效（不报错、不生效）。现在真正接线。
    maxTokens: options.maxTokens,
  });
  return {
    data: result.pairs,
    total: result.total,
    truncated: result.total > result.pairs.length,
    candidates: candidates.length,
    // participating/skipped 让调用方能区分「取了 200 行」与「比较了 200 行」。
    // 只看 candidates 会在候选含大量过短提交时误判分析覆盖率。
    participating: result.participating,
    skipped: result.skipped,
    buckets: result.buckets,
    threshold,
    limit,
    max_submissions: maxSubmissions,
  };
}
