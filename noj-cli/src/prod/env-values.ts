/**
 * `.env.prod` 键值读取的小工具（**生产与 drill 共用**）。
 *
 * 从 `drill/plan.ts` 移到这里：生产 `backup restore --confirm` 也需要它，
 * 而让 `backup/` 反向依赖 `drill/` 会把两条路径耦合成"删 drill 就编译不过"。
 * 放在 `prod/` 层的公共位置后，两边都只依赖这一处。
 */

/**
 * 取 `env[key]`；缺失或空串时返回 `fallback`。
 *
 * "空串等同缺失"是有意的：`.env.prod` 里 `KEY=` 与不写该键在 bash 的
 * `${KEY:-default}` 语义下等价，本函数与之一致。
 */
export function valueOr(
  env: Record<string, string>,
  key: string,
  fallback: string,
): string {
  const v = env[key];
  return v === undefined || v === "" ? fallback : v;
}
