import type {
  ContentReviewProvider,
  ReviewContext,
  ReviewResult,
} from "./types.ts";
import { logger } from "./../../../shared/base/logging.ts";

/**
 * 阿里云内容安全（Green）文本审核 Provider（issue #413）。
 *
 * 使用官方 @alicloud/green20180509 SDK 的 TextScan 同步审核接口。
 * 配置（经系统设置，key 为审核 AccessKey）：
 * - content_review_provider = aliyun
 * - content_review_provider_key    → AccessKey ID
 * - content_review_provider_secret → AccessKey Secret
 *
 * 注意：SDK 动态导入（CJS/ESM 互操作，参照 email-providers/aliyun.ts）。
 * 网络异常/服务不可用时抛错，由上层 fail-open 转人工，不阻断业务。
 */

/** TextScan 返回的单条文本结果。 */
interface AliyunScanItem {
  taskId?: string;
  dataId?: string;
  /** 0 表示调用成功（业务上是否有风险看 suggestions） */
  code?: number;
  msg?: string;
  label?: string;
  /** 建议：pass / review / block */
  suggestions?: string;
  /** 结果明细（含 hitWords 等） */
  results?: Array<{
    scene: string;
    label: string;
    suggestion?: string;
    rate?: number;
    hitWords?: string[];
  }>;
}

export interface AliyunProviderConfig {
  accessKeyId: string;
  accessKeySecret: string;
  /** 地域网关，默认华东2（上海）；文本审核 endpoint 固定为 green.aliyuncs.com */
  endpoint?: string;
  /** 额外审核场景，默认 ["antispam"] */
  scenes?: string[];
}

/**
 * 阿里云内容安全 Provider。
 * 构造时需已提供密钥（由工厂在确认设置后再实例化）。
 */
export class AliyunReviewProvider implements ContentReviewProvider {
  readonly name = "aliyun";
  private readonly client: Promise<unknown>;
  private readonly scenes: string[];

  constructor(private readonly config: AliyunProviderConfig) {
    this.scenes = config.scenes ?? ["antispam"];
    // 延迟动态导入，避免冷启动加载无关 SDK
    this.client = this.createClient();
  }

  private async createClient(): Promise<unknown> {
    // deno-lint-ignore no-explicit-any
    const Mod: any = await import("npm:@alicloud/green20180509@^1.0.1");
    const Client = Mod["module.exports"].default;
    return new Client({
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
      endpoint: this.config.endpoint ?? "green.cn-shanghai.aliyuncs.com",
    });
  }

  /**
   * 同步审核单段文本。
   * @throws 网络/参数错误由 SDK 抛出，上层捕获后 fail-open。
   */
  async reviewText(
    text: string,
    ctx: ReviewContext,
  ): Promise<ReviewResult> {
    const client = await this.client;
    const maxLen = ctx.maxLength ?? 2000;
    const content = text.length > maxLen ? text.slice(0, maxLen) : text;

    // deno-lint-ignore no-explicit-any
    const Mod: any = await import("npm:@alicloud/green20180509@^1.0.1");
    const TSReq = Mod["module.exports"].TextScanRequest;

    const request = new TSReq({
      scenes: this.scenes,
      tasks: [
        {
          dataId: `noj-${ctx.content_type}`,
          content,
        },
      ],
    });
    // deno-lint-ignore no-explicit-any
    const resp: any = await (client as any).textScan(request);
    const body = resp?.body ?? resp;
    const item: AliyunScanItem | undefined = body?.data?.[0];

    if (!item || (item.code !== undefined && item.code !== 0)) {
      logger.error("阿里云内容安全审核返回异常", {
        code: item?.code,
        msg: item?.msg ?? body?.msg ?? body?.code,
      });
      throw new Error(
        `阿里云内容安全调用失败: ${item?.msg ?? body?.msg ?? "未知错误"}`,
      );
    }

    const suggestion = item.suggestions ?? item.results?.[0]?.suggestion;
    const result = item.results?.[0];
    const label = item.label ?? result?.label;

    // 归一化：pass / review / block
    let verdict: ReviewResult["verdict"] = "pass";
    if (suggestion === "block") verdict = "block";
    else if (suggestion === "review") verdict = "review";

    const hitWords = result?.hitWords ?? [];
    const riskLevel: ReviewResult["riskLevel"] = verdict === "block"
      ? "high"
      : verdict === "review"
      ? "medium"
      : "low";

    return {
      verdict,
      // 阿里云 results[].rate 为 0-100 风险分（部分场景缺失时按 suggestion 映射）
      score: typeof result?.rate === "number"
        ? Math.round(result.rate)
        : verdict === "block"
        ? 90
        : verdict === "review"
        ? 60
        : 0,
      label: label ? [String(label)] : undefined,
      hitWords,
      riskLevel,
      detail: item.msg,
      provider: "aliyun",
    };
  }

  /** 连通性自检：调用一次空文本审核不可行，此处仅确认 client 可构造。 */
  async ping(): Promise<void> {
    await this.client;
  }
}
