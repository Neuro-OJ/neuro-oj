/**
 * 随机密钥生成。
 *
 * `randomKey` 被 `prod/lifecycle.ts`（首装生成强随机密钥）与 `prod/config.ts`
 * （备份口令回退）使用。实现零依赖（WebCrypto）。
 */

/**
 * 生成 `bytes` 字节的随机 hex 字符串（长度 `bytes * 2`）。
 *
 * 用 `crypto.getRandomValues`（CSPRNG）而非 `Math.random`——调用方拿它生成
 * 数据库口令、JWT 密钥、GPG 备份口令，弱随机会直接导致凭据可预测。
 */
export function randomKey(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}
