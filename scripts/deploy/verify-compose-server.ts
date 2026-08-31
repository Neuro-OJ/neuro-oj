/** 校验 docker-compose.prod.yml 已从 noj-core/core 改名为 noj-server/server。 */
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

  if (text.includes("noj-core")) {
    problems.push("compose 仍出现 noj-core（应全部改名 noj-server）");
  }
  if (/^\s{2}core:\s*$/m.test(text)) {
    problems.push("compose 仍存在服务 core（应为 server）");
  }
  if (!text.includes("x-server-env: &server-env")) {
    problems.push(
      "compose 缺少锚点 x-server-env: &server-env（应替换 x-core-env）",
    );
  }
  if (!text.includes("/noj-server:${NOJ_VERSION")) {
    problems.push(
      "compose server/migrate 镜像未使用 ghcr.io/neuro-oj/noj-server",
    );
  }
  if (!/^\s{2}server:\s*$/m.test(text)) {
    problems.push("compose 缺少服务 server");
  }
  if (!text.includes("NUXT_API_BASE: http://server:8000")) {
    problems.push("ui 的 NUXT_API_BASE 未指向 http://server:8000");
  }
  // ui 的 depends_on 下必须有 server；该行缩进 6 空格，形如 `      server:`
  if (!/^\s{6}server:\s*$/m.test(text)) {
    problems.push("depends_on 中缺少 server 依赖项");
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
