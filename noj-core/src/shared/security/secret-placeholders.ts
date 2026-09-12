/**
 * 密钥占位值检测（单一事实源）。
 *
 * 背景（2026-09-12 架构评审 §2.4）：`.env.prod.example` 中
 * `JWT_SECRET=change-me-to-a-random-string-at-least-32-chars` 长度 46 ≥ 32，
 * **能通过 main.ts 的启动长度校验**，而 compose 的 `${JWT_SECRET:?}` 只拦空值。
 * 于是"照文档 `cp .env.prod.example .env.prod` 后直接 up -d"会以**公开已知的密钥**
 * 上线，攻击者可伪造任意用户（含 admin）的 token。
 * 占位值兜底此前只存在于 `scripts/deploy/deploy.sh`（shell 实现），
 * 手动部署路径完全没有防线。
 *
 * 现把检测收敛到本模块，供三处复用：
 * - `src/main.ts`：启动期硬拒绝（JWT_SECRET / TFA_ENCRYPTION_KEY）；
 * - `scripts/check-env.ts`：`.env` 巡检（提前暴露，避免到启动才报错）；
 * - 单元测试：保证黑名单不会静默失效。
 */

/**
 * 已知占位值黑名单（不区分大小写）。命中即视为"未真正配置"。
 *
 * 与 `scripts/deploy/deploy.sh` 的 `is_placeholder()` 语义保持一致；
 * 注意 `/^test$/` 等为**整体匹配**，因此形如
 * `noj-test-jwt-secret-fixed-value-with-32-chars-min` 的固定测试密钥不会被误杀。
 */
export const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^change-?this/i,
  /^change-?me/i,
  /^changeme$/i,
  /^example$/i,
  /^test$/i,
  /^xxx+$/i,
  /^placeholder/i,
  /your[-_]?(secret|password|key)/i,
  /replace-?me/i,
  /TODO/i,
  // 审计 NOJ-131：仓库历史模板中公开过的默认管理员凭据
  /^admin@noj\.local$/i,
  /^AdminPass123!$/i,
  // 补充：文案里常见的"随机串提示"本身就是占位值
  /^random[-_ ]?string/i,
  /^at-least-\d+/i,
];

/**
 * 判断给定值是否为占位值（空/未设置也算"未配置"，返回 true）。
 */
export function isPlaceholderSecret(value: string | null | undefined): boolean {
  if (!value) return true;
  return PLACEHOLDER_PATTERNS.some((p) => p.test(value));
}

/**
 * 校验密钥不是占位值；命中时返回可读的失败原因，否则返回 null。
 *
 * 返回原因而不是抛错，便于调用方决定是"记日志 + 退出"还是"收集为巡检发现"。
 */
export function describePlaceholderSecret(
  name: string,
  value: string | null | undefined,
): string | null {
  if (!value) return `${name} 未设置`;
  const hit = PLACEHOLDER_PATTERNS.find((p) => p.test(value));
  if (!hit) return null;
  return `${name} 命中占位值黑名单（模式 ${hit}）——它可能来自示例文件，攻击者可据此伪造任意用户 token`;
}
