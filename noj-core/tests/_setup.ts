/**
 * 测试数据库 setup 公共入口。
 *
 * 具体实现位于 `tests/helpers/db.ts`；本文件仅保留稳定导出，避免测试直接依赖
 * 生产连接模块。
 */
export {
  assertOwnedTestDatabase,
  resetDbForTest,
  seedTestDatabase,
  setupSchemaForTest,
} from "./helpers/db.ts";
