import type {
  ContentReviewProvider,
  ReviewContext,
  ReviewResult,
} from "./types.ts";
import { logger } from "./../../../shared/base/logging.ts";

/**
 * 腾讯云内容安全（CMS）文本审核 Provider（issue #413）。
 *
 * 使用官方 tencentcloud-sdk-nodejs-cms 的 TextModeration 同步接口。
 * 配置（经系统设置，key 为审核 SecretId）：
 * - content_review_provider = tencent
 * - content_review_provider_key    → SecretId
 * - content_review_provider_secret → SecretKey
 *
 * 参照 email-providers/tencent.ts 的动态导入方式。
 * 网络异常/服务不可用时抛错，由上层 fail-open 转人工，不阻断业务。
 */

interface TencentModerationData {
  /** 恶意请求返回的命中标签（如 "Normal" / "Porn" 等） */
  Label?: string;
  /** 建议：Pass / Review / Block */
  Suggestion?: string;
  /** 0-100 风险分数 */
  Score?: number;
  /** 命中的关键词 */
  Keywords?: string[];
  /** 细分结果 */
  DetailResults?: Array<{
    Label?: string;
    Suggestion?: string;
    Score?: number;
    Keywords?: string[];
  }>;
}

export interface TencentProviderConfig {
  secretId: string;
  secretKey: string;
  region?: string;
}

/**
 * 腾讯云 CMS 内容安全 Provider。
 * 构造时需已提供密钥（由工厂在确认设置后再实例化）。
 */
export class TencentReviewProvider implements ContentReviewProvider {
  readonly name = "tencent";
  private readonly client: Promise<unknown>;

  constructor(private readonly config: TencentProviderConfig) {
    this.client = this.createClient();
  }

  private async createClient(): Promise<unknown> {
    // deno-lint-ignore no-explicit-any
    const { cms }: any = await import(
      "npm:tencentcloud-sdk-nodejs-cms@^4.1.71"
    );
    const v = cms.v20190321;
    return new v.Client({
      credential: {
        secretId: this.config.secretId,
        secretKey: this.config.secretKey,
      },
      region: this.config.region ?? "ap-guangzhou",
      profile: {
        httpProfile: {
          endpoint: "cms.tencentcloudapi.com",
        },
      },
    });
  }

  /**
   * 同步审核单段文本（TextModeration，要求 Content 为 base64）。
   * @throws 网络/鉴权错误由 SDK 抛出，上层捕获后 fail-open。
   */
  async reviewText(
    text: string,
    ctx: ReviewContext,
  ): Promise<ReviewResult> {
    const client = await this.client;
    const maxLen = ctx.maxLength ?? 2000;
    const content = text.length > maxLen ? text.slice(0, maxLen) : text;

    const request = {
      Content: btoa(unescape(encodeURIComponent(content))),
    };

    // deno-lint-ignore no-explicit-any
    const resp: any = await (client as any).TextModeration(request);
    const data: TencentModerationData | undefined = resp?.Data;

    if (resp?.Error || !data) {
      const errMsg = resp?.Error?.Message ?? "未知错误";
      logger.error("腾讯云内容安全审核返回异常", {
        code: resp?.Error?.Code,
        message: errMsg,
      });
      throw new Error(`腾讯云内容安全调用失败: ${errMsg}`);
    }

    const suggestion = data.Suggestion?.toLowerCase(); // pass/review/block
    let verdict: ReviewResult["verdict"] = "pass";
    if (suggestion === "block") verdict = "block";
    else if (suggestion === "review") verdict = "review";

    const hitWords = data.Keywords ?? data.DetailResults?.[0]?.Keywords ?? [];
    const riskLevel: ReviewResult["riskLevel"] = verdict === "block"
      ? "high"
      : verdict === "review"
      ? "medium"
      : "low";

    return {
      verdict,
      score: typeof data.Score === "number"
        ? Math.round(data.Score)
        : verdict === "block"
        ? 90
        : verdict === "review"
        ? 60
        : 0,
      label: data.Label ? [String(data.Label)] : undefined,
      hitWords,
      riskLevel,
      detail: data.Label,
      provider: "tencent",
    };
  }

  /** 连通性自检：确认 client 可构造。 */
  async ping(): Promise<void> {
    await this.client;
  }
}
