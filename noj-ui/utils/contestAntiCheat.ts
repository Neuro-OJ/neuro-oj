/**
 * 竞赛风控（人工复核线索）的 DTO 契约与展示辅助。
 *
 * 放在 `utils/` 而非 composable 内：本仓库的约定是**纯逻辑与契约放 utils**
 * （可被 `deno task test` 直接类型检查与断言），Nuxt 依赖（useApi/useI18n）
 * 留在 composable 内。composable 从本文件引用类型。
 */

/**
 * 相似提交对。
 *
 * 字段与后端 `SimilarSubmissionPair`（noj-core
 * `domains/contest/services/contest-similarity.ts` 的 `SimilarSubmissionPair`）对齐。
 * **响应不含源代码**——源码属于提交详情端点的职责（最小暴露面）。
 */
export interface SimilarSubmissionPair {
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
  similarity: number;
  shared_fingerprints: number;
  fingerprint_count_a: number;
  fingerprint_count_b: number;
}

/**
 * 相似度分析的规模与覆盖率元数据。
 *
 * 这些字段的存在意义是**避免把"没算到"误读成"没有相似提交"**：
 * 后端为 200 份候选上限返回 `truncated`，并把"真正比较了多少"（`participating`）
 * 与"取了多少候选"（`candidates`）分开，缺少它们会误导管理员。
 */
export interface SimilarSubmissionsMeta {
  threshold: number;
  limit: number;
  total: number;
  truncated: boolean;
  candidates: number;
  participating: number;
  skipped: number;
  buckets: number;
  max_submissions: number;
}

/** 相似提交接口的完整响应形状（含数据政策声明）。 */
export interface SimilarSubmissionsResponse {
  data: SimilarSubmissionPair[];
  meta: SimilarSubmissionsMeta;
  data_policy: {
    purpose: string;
    retention_days: number;
    automated_penalty: boolean;
  };
}

/**
 * 构造覆盖率说明文案。
 *
 * 不返回 null 而返回空串会让调用方误判，故无 meta 时返回 null，
 * 由调用方决定是否渲染。
 *
 * @param meta 后端返回的元数据；缺省时返回 null。
 * @returns 形如「比较 37 份 / 候选 120 份，跳过 5 份」的说明；无 meta 时为 null。
 */
export function describeCoverage(meta?: SimilarSubmissionsMeta | null): string | null {
  if (!meta) return null;
  return `比较 ${meta.participating} 份 / 候选 ${meta.candidates} 份，跳过 ${meta.skipped} 份`;
}

/**
 * 判断结果是否因规模上限被截断。
 *
 * 抽成函数是为了让"截断必须显式提示"这一约束有单一判定点，
 * 避免各调用点各写一次 `meta.truncated === true` 而漏掉某处。
 *
 * @param meta 后端返回的元数据。
 * @returns 需要向管理员显示截断提示时为 true。
 */
export function isTruncated(meta?: SimilarSubmissionsMeta | null): boolean {
  return meta?.truncated === true;
}
