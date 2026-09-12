// sitemap 绝对 URL 的 origin 解析（2026-09-12 架构评审 §4.2）。
//
// 抽成独立模块的原因：sitemap 路由文件末尾会调用 `defineEventHandler`（Nitro 自动
// 导入），直接在单测中 import 该文件会因 `defineEventHandler is not defined` 失败，
// 因此把纯函数放在 server/utils 下以便测试。

/**
 * 校验请求头派生的 host 形状。
 *
 * 只接受 `host[:port]`（含 IPv6 字面量）形态；拒绝空值、超长、含空白 / 斜杠 /
 * `@` / `?` / `#` 等会破坏 URL 结构的字符。
 */
export function sanitizeHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const trimmed = host.trim();
  if (trimmed.length === 0 || trimmed.length > 255) return null;
  if (/[\s/\\@?#]/.test(trimmed)) return null;
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * 解析用于拼接绝对 URL 的 origin。
 *
 * **配置优先**：`NUXT_SITE_URL` 提供的权威地址始终胜过请求 Host 头——这是修复
 * sitemap 缓存投毒的关键（Host 由客户端控制，不可作为缓存键的事实来源）。
 * 未配置时才回退到校验过的 Host 头，仅用于本地开发。
 */
export function resolveOrigin(
  configuredSiteUrl: string | undefined,
  protocolHeader: string | null,
  hostHeader: string | null,
): string | null {
  const configured = configuredSiteUrl?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const host = sanitizeHost(hostHeader);
  if (!host) return null;
  const protocol = protocolHeader === 'https' ? 'https' : 'http';
  return `${protocol}://${host}`;
}
