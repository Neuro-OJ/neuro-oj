/**
 * 兼容旧调用路径的并行测试入口。
 *
 * 正式资源创建、迁移、seed、分片克隆和清理均由统一
 * `scripts/test-launcher.ts parallel` 完成；这里不再读取 `.env`、创建 schema、
 * 复用 Redis 进程或执行 FLUSHDB。
 */
import { main } from "./test-launcher.ts";

if (import.meta.main) {
  try {
    Deno.exit(await main(["parallel", ...Deno.args]));
  } catch (error) {
    console.error(`[test-parallel] 失败：${String(error)}`);
    Deno.exit(1);
  }
}
