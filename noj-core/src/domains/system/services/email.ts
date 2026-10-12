/**
 * 邮件发送入口。
 *
 * 根据环境变量 EMAIL_PROVIDER 动态选择 Provider：
 * - disabled：关闭邮件发送
 * - mock（默认）：仅控制台日志输出
 * - aliyun：阿里云 DirectMail
 * - tencent：腾讯云 SES
 *
 * 启动时在 main.ts 中校验 Provider 环境变量完整性；生产环境可以显式关闭邮件。
 */

import type {
  SendEmail,
  SendPasswordResetEmail,
} from "./email-providers/types.ts";
import { buildEmailVerificationHtml } from "./email-providers/common.ts";
import { getSetting } from "./system-settings.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "system"]);
import { observability as metrics } from "../../../domains/observability/write.ts";

/** 每个 Provider 模块必须实现的最小接口。 */
interface EmailProviderModule {
  sendPasswordResetEmail: SendPasswordResetEmail;
  sendEmail: SendEmail;
}

/**
 * Provider 名称到**惰性加载器**的映射。
 *
 * ⚠️ 这里的动态 `import()` 必须写成**字面量说明符**，不得改回
 * `import(modulePath)`（变量说明符）。`deno compile` 只对字面量动态导入做静态
 * 分析并把模块内联进单文件二进制；变量说明符编译期不报错，运行时才抛
 * `Module not found: file:///tmp/deno-compile-noj-server/...`——生产镜像是
 * `deno compile` 产物，因此这条路径**只在生产容器里炸**，本地 `deno task dev`
 * 与单元测试全绿（2026-09-25 实测：`noj-server:0.10.1-alpha.2` 发送邮件/邮箱验证
 * 全部 500，日志见 `Module not found .../email-providers/aliyun.ts`）。
 * 回归门禁：`scripts/verify-compile-safe-imports.ts`。
 * 装配点白名单：`scripts/verify-capability-seams.ts`（静态/动态导入都算引用）。
 */
const PROVIDER_LOADERS: Record<
  string,
  () => Promise<EmailProviderModule>
> = {
  disabled: () => import("./email-providers/disabled.ts"),
  mock: () => import("./email-providers/mock.ts"),
  aliyun: () => import("./email-providers/aliyun.ts"),
  tencent: () => import("./email-providers/tencent.ts"),
};

/** 当前生效的 Provider 名称（配置读取链：DB → env → 默认值 mock）。 */
function currentProvider(): string {
  return String(getSetting("email_provider")?.value ?? "mock");
}

/** 已缓存的 send 函数引用 */
let sendFn: SendPasswordResetEmail | null = null;
let sendEmailFn: SendEmail | null = null;

/**
 * 加载当前 EMAIL_PROVIDER 对应的发送函数。
 *
 * 在首次调用时动态导入，后续调用复用缓存。设计上允许 main.ts 在启动时
 * 通过 setEmailProvider() 覆盖 provider 选择（例如降级时）。
 */
async function loadSendFn(): Promise<SendPasswordResetEmail> {
  if (sendFn) return sendFn;

  const provider = currentProvider();

  if (
    Deno.env.get("NOJ_ENV") === "production" &&
    (provider === "mock" || !PROVIDER_LOADERS[provider])
  ) {
    throw new Error(
      "生产环境禁止使用 mock 邮件 Provider；请配置 email_provider=aliyun、tencent 或 disabled",
    );
  }

  const load = PROVIDER_LOADERS[provider];

  if (!load) {
    logger.warn("未知的 EMAIL_PROVIDER，使用 mock 替代", { provider });
    Deno.env.set("EMAIL_PROVIDER", "mock");
    const mod = await PROVIDER_LOADERS.mock();
    sendFn = mod.sendPasswordResetEmail;
    return sendFn;
  }

  const mod = await load();
  sendFn = mod.sendPasswordResetEmail;
  return sendFn;
}

/**
 * 重置缓存的 Provider 函数。
 *
 * 用于 main.ts 降级时强制重新加载。
 */
export function resetEmailProvider(): void {
  sendFn = null;
  sendEmailFn = null;
}

async function loadGenericSendFn(): Promise<SendEmail> {
  if (sendEmailFn) return sendEmailFn;
  const provider = currentProvider();
  const load = PROVIDER_LOADERS[provider];
  if (!load) {
    throw new Error(`未知的 EMAIL_PROVIDER：${provider}`);
  }
  if (Deno.env.get("NOJ_ENV") === "production" && provider === "mock") {
    throw new Error("生产环境禁止使用 mock 邮件 Provider");
  }
  const mod = await load();
  sendEmailFn = mod.sendEmail;
  return sendEmailFn;
}

/**
 * 发送密码重置邮件。
 *
 * 根据环境变量 EMAIL_PROVIDER 自动选择底层实现。
 *
 * @param email - 收件人邮箱
 * @param resetLink - 完整的密码重置链接（含 token）
 * @param expiresInMinutes - 过期时间（分钟）
 */
export async function sendPasswordResetEmail(
  email: string,
  resetLink: string,
  expiresInMinutes = 15,
): Promise<void> {
  metrics.inc("noj_email_send_attempts_total", {
    provider: currentProvider(),
    message_type: "password_reset",
  });
  const fn = await loadSendFn();
  await fn(email, resetLink, expiresInMinutes);
}

/** 发送邮箱验证邮件。 */
export async function sendEmailVerificationEmail(
  email: string,
  verifyLink: string,
  expiresInMinutes = 30,
): Promise<boolean> {
  metrics.inc("noj_email_send_attempts_total", {
    provider: currentProvider(),
    message_type: "verification",
  });
  const fn = await loadGenericSendFn();
  return await fn(
    email,
    "验证您的 Neuro OJ 邮箱",
    buildEmailVerificationHtml(verifyLink, expiresInMinutes),
  );
}

/**
 * 发送管理后台测试邮件（issue #426）。
 *
 * 供管理员在开放公开注册前验证邮件配置是否真实可用；
 * disabled Provider 会返回 false，临时故障由调用方捕获并反馈。
 */
export async function sendTestEmail(to: string): Promise<boolean> {
  metrics.inc("noj_email_send_attempts_total", {
    provider: currentProvider(),
    message_type: "test",
  });
  const fn = await loadGenericSendFn();
  return await fn(
    to,
    "Neuro OJ 测试邮件",
    "<p>这是一封来自 Neuro OJ 管理后台的测试邮件。</p>" +
      "<p>收到此邮件说明当前邮件服务配置可用，可以开放公开注册。</p>",
  );
}
