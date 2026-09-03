import type { ContentReviewProvider } from "./types.ts";
import { MockReviewProvider } from "./mock.ts";
import { AliyunReviewProvider } from "./aliyun.ts";
import { TencentReviewProvider } from "./tencent.ts";
import { getSetting } from "../../system/index.ts";
import { logger } from "./../../../shared/base/logging.ts";

/**
 * 从系统设置读取审核 Provider 配置并实例化。
 *
 * 读取键（issue #413）：
 * - content_review_provider：mock / aliyun / tencent / none
 * - content_review_provider_key：AccessKey ID / SecretId
 * - content_review_provider_secret：AccessKey Secret / SecretKey
 *
 * 返回 null 表示"不审核"：
 * - provider 为 none / 未知值
 * - provider 为 aliyun/tencent 但密钥未配置（记 warning，fail-open 由上层处理）
 */
export function createReviewProvider(): ContentReviewProvider | null {
  const name = String(getSetting("content_review_provider")?.value ?? "mock");
  const key = String(getSetting("content_review_provider_key")?.value ?? "");
  const secret = String(
    getSetting("content_review_provider_secret")?.value ?? "",
  );

  switch (name) {
    case "mock":
      return new MockReviewProvider({
        // mock 支持通过 provider_key 注入违禁词（逗号分隔），便于运营试用
        blockWords: key
          ? key.split(",").map((w) => w.trim()).filter(Boolean)
          : [],
      });
    case "aliyun":
      if (!key || !secret) {
        logger.warn(
          "[content-review] 阿里云审核密钥未配置，本次不审核（fail-open）",
        );
        return null;
      }
      return new AliyunReviewProvider({
        accessKeyId: key,
        accessKeySecret: secret,
      });
    case "tencent":
      if (!key || !secret) {
        logger.warn(
          "[content-review] 腾讯云审核密钥未配置，本次不审核（fail-open）",
        );
        return null;
      }
      return new TencentReviewProvider({
        secretId: key,
        secretKey: secret,
      });
    case "none":
    default:
      return null;
  }
}
