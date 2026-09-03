/**
 * 内容合规审核 Provider 抽象（issue #413）。
 *
 * 统一接口不绑定单一厂商：mock / aliyun / tencent 均实现
 * ContentReviewProvider；上层（UGC 同步审核钩子、私信异步消费者）
 * 只依赖本接口 + 裁决服务，不感知具体厂商差异。
 */

/** 机器判定原始结论。 */
export type ReviewVerdict = "pass" | "review" | "block" | "error";

/** 风险级别（归一化）。 */
export type ReviewRiskLevel = "low" | "medium" | "high";

/** Provider 判定结果。 */
export interface ReviewResult {
  verdict: ReviewVerdict;
  /** 风险分数（0-100，与阈值比较用；mock 等无分数 Provider 可省略） */
  score?: number;
  /** 命中分类标签（如 ["政治","广告"]） */
  label?: string[];
  /** 命中词（送审时按隐私要求记录，命中为空数组/undefined 表示无命中） */
  hitWords?: string[];
  riskLevel?: ReviewRiskLevel;
  /** 原始返回的摘要说明（脱敏，仅内部展示） */
  detail?: string;
  /** 判定 Provider：mock / aliyun / tencent */
  provider: string;
}

/** 审核上下文（送审文本来源）。 */
export interface ReviewContext {
  /** 关联内容类型 */
  content_type: "post" | "comment" | "message";
  /** 送审文本截断上限（字符数，按 Provider 限制截断） */
  maxLength?: number;
}

/** 内容审核 Provider 统一接口。 */
export interface ContentReviewProvider {
  readonly name: string;
  /** 审核单段文本。同步（UGC）/ 异步（私信）共用。 */
  reviewText(text: string, ctx: ReviewContext): Promise<ReviewResult>;
  /** 连通性自检（可选；用于配置完成后验证）。 */
  ping?(): Promise<void>;
}
