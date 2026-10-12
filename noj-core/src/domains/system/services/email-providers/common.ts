import { getSetting } from "../system-settings.ts";

/**
 * 读取系统设置中的字符串值，未配置时抛错。
 *
 * @param key 设置项 key
 * @param label 错误提示中的配置项名称
 * @returns 配置字符串
 * @throws {Error} 未配置时
 */
export function getSettingOrThrow(key: string, label: string): string {
  const val = getSetting(key);
  const str = typeof val?.value === "string" ? val.value : "";
  if (!str) {
    throw new Error(
      `[email] ${label} 未配置，请通过系统设置或环境变量配置`,
    );
  }
  return str;
}

/** 转义插入 HTML 文本或属性值的字符串。 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 带单个行动按钮的事务邮件内容（文案均为可信常量，不做转义）。 */
interface ActionEmailContent {
  /** `<title>` 与收件箱标题 */
  title: string;
  /** 收件箱列表中的预览摘要 */
  preheader: string;
  /** 正文大标题 */
  heading: string;
  /** 正文段落 */
  paragraphs: string[];
  /** 按钮文案 */
  buttonText: string;
  /** 按钮链接（会被转义） */
  link: string;
  /** 链接有效期（分钟） */
  expiresInMinutes: number;
  /** 页脚“非本人操作”提示 */
  ignoreNotice: string;
}

/**
 * 渲染带单个行动按钮的品牌事务邮件。
 *
 * 邮件客户端（Outlook、Gmail、QQ 邮箱等）对 CSS 支持有限，因此采用表格布局 +
 * 内联样式，不依赖 `<style>`、外部字体或图片；配色遵循品牌 token
 * （dev-docs/design/noj-design-tokens.md）。
 */
function renderActionEmailHtml(content: ActionEmailContent): string {
  const link = escapeHtml(content.link);
  const minutes = content.expiresInMinutes;
  const font =
    "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',Helvetica,Arial,sans-serif";
  const paragraphs = content.paragraphs.map((text, i) =>
    `<p style="margin:0 0 ${
      i === content.paragraphs.length - 1 ? 28 : 12
    }px 0;font-size:15px;line-height:1.7;color:#334155;">${text}</p>`
  ).join("\n            ");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${content.title}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${content.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f5f9;">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:6px;font-family:${font};">
        <tr>
          <td style="background-color:#0b0f19;border-radius:6px 6px 0 0;padding:24px 32px;">
            <span style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">Neuro OJ</span>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 32px 8px 32px;">
            <h1 style="margin:0 0 16px 0;font-size:22px;line-height:1.4;font-weight:600;color:#0f172a;">${content.heading}</h1>
            ${paragraphs}
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#0284c7" style="border-radius:4px;">
                  <a href="${link}" target="_blank" style="display:inline-block;padding:12px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:4px;">${content.buttonText}</a>
                </td>
              </tr>
            </table>
            <p style="margin:28px 0 0 0;font-size:13px;line-height:1.7;color:#64748b;">此链接 <strong style="color:#0f172a;font-variant-numeric:tabular-nums;">${minutes}</strong> 分钟内有效，且仅可使用一次。</p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 32px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;">
              <tr>
                <td style="padding:14px 16px;font-size:12px;line-height:1.6;color:#64748b;">
                  按钮无法点击？请复制以下链接到浏览器打开：<br>
                  <a href="${link}" target="_blank" style="color:#0284c7;word-break:break-all;">${link}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="border-top:1px solid #e2e8f0;padding:20px 32px;font-size:12px;line-height:1.6;color:#94a3b8;">
            ${content.ignoreNotice}<br>
            此邮件由系统自动发送，请勿直接回复。
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * 构建密码重置邮件 HTML 正文。
 *
 * @param resetLink 完整的密码重置链接（含 token）
 * @param expiresInMinutes 过期时间（分钟）
 * @returns HTML 字符串
 */
export function buildResetPasswordHtml(
  resetLink: string,
  expiresInMinutes: number,
): string {
  return renderActionEmailHtml({
    title: "重置您的 Neuro OJ 密码",
    preheader: `点击按钮重置密码，链接 ${expiresInMinutes} 分钟内有效。`,
    heading: "重置您的密码",
    paragraphs: [
      "您好，我们收到了重置您 Neuro OJ 账号密码的请求。",
      "请点击下方按钮设置新密码。",
    ],
    buttonText: "重置密码",
    link: resetLink,
    expiresInMinutes,
    ignoreNotice: "如果这不是您本人的操作，请忽略此邮件，您的密码不会被修改。",
  });
}

/**
 * 构建邮箱验证邮件 HTML 正文。
 *
 * @param verifyLink 完整的邮箱验证链接（含 token）
 * @param expiresInMinutes 过期时间（分钟）
 * @returns HTML 字符串
 */
export function buildEmailVerificationHtml(
  verifyLink: string,
  expiresInMinutes: number,
): string {
  return renderActionEmailHtml({
    title: "验证您的 Neuro OJ 邮箱",
    preheader: `点击按钮完成邮箱验证，链接 ${expiresInMinutes} 分钟内有效。`,
    heading: "验证您的邮箱地址",
    paragraphs: [
      "您好，欢迎注册 Neuro OJ！",
      "请点击下方按钮完成邮箱验证，以激活您的账号并解锁提交评测等功能。",
    ],
    buttonText: "验证邮箱",
    link: verifyLink,
    expiresInMinutes,
    ignoreNotice:
      "如果这不是您本人的操作，请忽略此邮件，您的邮箱不会被绑定到任何账号。",
  });
}
