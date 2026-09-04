import type {
  ContentReviewProvider,
  ReviewContext,
  ReviewResult,
} from "./types.ts";

/**
 * Mock 内容审核 Provider。
 *
 * 本地确定性审核，用于开发与测试：
 * - 命中 blockWords → block（高置信）
 * - 命中 reviewWords → review（疑似转人工）
 * - 其余 → pass
 *
 * 也支持直接注入自定义规则函数（测试用），覆盖 Provider 异常等路径。
 */
export class MockReviewProvider implements ContentReviewProvider {
  readonly name = "mock";

  constructor(
    private readonly opts: {
      blockWords?: string[];
      reviewWords?: string[];
      /** 自定义判定规则（优先于词表）；返回 null 表示回退到词表判定。 */
      custom?: (text: string) => ReviewResult | null;
    } = {},
  ) {}

  reviewText(text: string, _ctx: ReviewContext): Promise<ReviewResult> {
    const custom = this.opts.custom?.(text);
    if (custom) return Promise.resolve({ ...custom, provider: "mock" });

    const blockWord = this.opts.blockWords?.find((w) => text.includes(w));
    if (blockWord) {
      return Promise.resolve({
        verdict: "block",
        label: ["违禁"],
        hitWords: [blockWord],
        riskLevel: "high",
        provider: "mock",
      });
    }
    const reviewWord = this.opts.reviewWords?.find((w) => text.includes(w));
    if (reviewWord) {
      return Promise.resolve({
        verdict: "review",
        label: ["疑似违规"],
        hitWords: [reviewWord],
        riskLevel: "medium",
        provider: "mock",
      });
    }
    return Promise.resolve({ verdict: "pass", provider: "mock" });
  }
}
