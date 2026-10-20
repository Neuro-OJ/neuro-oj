/**
 * 测试 preload。
 *
 * P2b 起不再拦截 `Deno.test`，也不创建全局测试事务或 savepoint 代理。
 * 测试启动器负责创建独立数据库、执行正式迁移并写入模板种子；各测试通过
 * `tests/helpers/db.ts` 显式执行 truncate + seed reset。
 */
import "./_setup.ts";
