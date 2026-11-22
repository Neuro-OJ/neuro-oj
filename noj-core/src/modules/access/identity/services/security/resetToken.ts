import { encodeBase64Url } from "jsr:@std/encoding@^1";

/**
 * 密码重置令牌生成与哈希工具（issue #49）。
 *
 * 设计要点：
 * - 明文 token 用 base64url 编码（43 字符），包含在邮件 URL 中
 * - DB 存 SHA-256 hex 哈希，**不存明文**（OWASP 2025+ 接受）
 * - 32 字节随机数，256 位熵，暴力不可行
 */

/**
 * 生成密码重置明文 token（base64url 编码）。
 *
 * 32 字节随机数 → base64url 编码 → 43 字符字符串。
 * 使用 Deno 内建 `crypto.getRandomValues()`（CSPRNG）。
 *
 * @returns base64url 编码的明文 token
 */
export function generateResetToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

/**
 * 计算 token 的 SHA-256 hex 哈希。
 *
 * 接收明文 token，输出 64 字符小写 hex 字符串。用于 DB 存储。
 * 邮件链接中传明文，查询时哈希后比较。
 *
 * @param token - 明文 token
 * @returns SHA-256 hex 哈希
 */
export async function hashResetToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
