/**
 * 预构建 PGlite 模板缓存。
 *
 * 构建一次包含完整 schema 和基础种子的 PGlite 数据目录，供测试进程通过
 * `loadDataDir` 快速加载，避免每个测试文件重复执行 DDL。
 *
 * 用法：
 *   deno run -A scripts/prepare-pglite-template.ts
 */
import { ensurePGliteTemplateCached } from "../src/db/connection.ts";

const templatePath = await ensurePGliteTemplateCached();
console.log(`PGlite 模板就绪: ${templatePath}`);
