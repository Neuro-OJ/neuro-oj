/**
 * noj-cli 测试共享工具。
 *
 * T23：原先这里还有 JSON 配置 fixture（`baseConfig`/`secrets`/`writeFixture`，
 * 生成 `noj-deploy.json` + `noj-secrets.json`）与 `fakeRunner`。它们随双模态一起
 * 删除——留着会继续 import 已删除的 `config/types.ts`，让"已删模态"以测试依赖的
 * 形式残存。生产侧（`prod/`）的测试全部自带注入 fake，不再需要共享 runner。
 */

/** 创建临时目录（统一封装，便于后续统一清理策略）。 */
export function makeTempDir(): Promise<string> {
  return Deno.makeTempDir();
}
