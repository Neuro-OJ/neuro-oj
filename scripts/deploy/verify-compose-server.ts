/** 校验生产 Compose 的兼容命名：core 服务使用当前已发布的 noj-server 镜像。 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const COMPOSE = path.join(ROOT, "docker-compose.prod.yml");

/** 返回问题清单；空数组表示通过。 */
export function verifyComposeServer(): string[] {
  const problems: string[] = [];
  const text = Deno.readTextFileSync(COMPOSE);

  if (!text.includes("x-core-env: &core-env")) {
    problems.push(
      "compose 缺少兼容锚点 x-core-env: &core-env",
    );
  }
  if (!text.includes("/noj-server:${NOJ_VERSION")) {
    problems.push(
      "compose core/migrate 镜像未使用当前已发布的 ghcr.io/neuro-oj/noj-server",
    );
  }
  if (!/^\s{2}core:\s*$/m.test(text)) {
    problems.push("compose 缺少兼容服务 core");
  }
  if (!text.includes("NUXT_API_BASE: http://core:8000")) {
    problems.push("ui 的 NUXT_API_BASE 未指向 http://core:8000");
  }
  // ui 的 depends_on 下必须有 core；该行缩进 6 空格，形如 `      core:`
  if (!/^\s{6}core:\s*$/m.test(text)) {
    problems.push("depends_on 中缺少 core 依赖项");
  }
  return problems;
}

if (import.meta.main) {
  const problems = verifyComposeServer();
  if (problems.length > 0) {
    console.error("❌ Compose 改名门禁失败：\n- " + problems.join("\n- "));
    Deno.exit(1);
  }
  console.log("✅ docker-compose.prod.yml 改名门禁通过");
}
