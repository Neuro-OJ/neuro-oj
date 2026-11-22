/**
 * noj-cli 测试共享工具。
 *
 * 生产侧（`prod/`）的测试全部自带注入 fake，这里不提供共享 runner。
 */

/** 创建临时目录（统一封装，便于后续统一清理策略）。 */
export function makeTempDir(): Promise<string> {
    return Deno.makeTempDir();
}
