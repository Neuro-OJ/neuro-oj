/**
 * 随机密钥生成（原 `init/secrets.ts`，T23 搬迁）。
 *
 * 为什么独立成模块：`randomKey` 被 `prod/lifecycle.ts`（首装生成强随机密钥）与
 * `prod/config.ts`（备份口令回退）使用，而它原先住的 `init/secrets.ts` 是双模态
 * 时代的产物——那里的 `generateSecrets`/`SecretsConfig` 属于 `noj-secrets.json`
 * 路径，已随 T23 删除。把 `randomKey` 留在一个以"JSON 配置"为主题的模块里，
 * 会让"prod 依赖了已删除的模态"这种错觉长期存在。
 *
 * 实现零依赖（WebCrypto），与 `init/secrets.ts` 原实现逐字一致。
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
