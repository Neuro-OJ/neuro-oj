/**
 * postgres.js 连接启动参数。
 *
 * 中文 2 字短查询会退化为全表扫描，PG 判为高代价并触发 JIT 编译；NOJ 的 OLTP
 * 负载默认关闭 JIT。测试数据库通过独立数据库隔离，不向生产连接注入测试
 * schema 或特殊连接模式。
 */

/**
 * 构造 postgres.js 的 `connection` 选项（libpq startup 参数）。
 *
 * - `jitDisabled` 为真时发送 `-cjit=off`。
 *
 * @param jitDisabled 是否关闭 PostgreSQL JIT
 * @returns postgres.js 的 connection 选项；无参数时为 undefined
 */
export function buildConnectionOptions(
  jitDisabled: boolean,
): { options: string } | undefined {
  const opts: string[] = [];
  if (jitDisabled) opts.push("-cjit=off");
  return opts.length > 0 ? { options: opts.join(" ") } : undefined;
}
