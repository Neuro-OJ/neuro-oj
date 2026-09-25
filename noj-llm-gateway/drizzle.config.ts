// 注意：这里用 **完整 URL 说明符** 是有意的，不要把 drizzle-kit 登记回
// deno.json 的 imports。drizzle-kit 只服务本文件与 `db:generate`，运行期
// `src/` 不引用；而 `nodeModulesDir: "auto"` 会把 import map 里的 npm 包整棵树
// 装进运行镜像，其传递依赖 esbuild 由 Go 编写，会让发布流水线的 Trivy 门禁失败
// （2026-09-25 v0.10.0 发布即因此阻塞）。详见
// `.agents/notes/implemented/bug-fix/2026-09-25-gateway-runtime-image-dev-deps.md`。
import { defineConfig } from "npm:drizzle-kit@0.31.10";

const databaseUrl = Deno.env.get("DATABASE_URL");
if (!databaseUrl) {
  throw new Error("环境变量 DATABASE_URL 未设置");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
