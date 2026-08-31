/** 校验 noj-server 构建脚本与 deno task 配置（P5 构建冒烟门禁）。 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readLines(rel: string): string[] {
  const p = path.join(ROOT, rel);
  return Deno.readTextFileSync(p).split(/\r?\n/);
}

/** 返回问题清单；空数组表示通过。 */
export function verifyBuildServerScript(): string[] {
  const problems: string[] = [];
  const lines = readLines("noj-core/scripts/build-server.sh");
  const joined = lines.join("\n");

  if (!joined.includes("deno compile")) {
    problems.push("build-server.sh 未使用 deno compile");
  }
  if (!joined.includes("--target x86_64-unknown-linux-gnu")) {
    problems.push("build-server.sh 未指定 linux/amd64 目标");
  }
  if (!joined.includes("bin/noj-server")) {
    problems.push("build-server.sh 未输出 bin/noj-server");
  }
  if (!joined.includes("src/main.ts")) {
    problems.push("build-server.sh 未引用 src/main.ts 入口");
  }

  const denoJson = JSON.parse(
    Deno.readTextFileSync(path.join(ROOT, "noj-core/deno.json")),
  ) as { tasks?: Record<string, string> };
  const buildTask = denoJson.tasks?.["build:server"] ?? "";
  if (!buildTask.includes("scripts/build-server.sh")) {
    problems.push(
      "deno.json 缺 build:server 任务（指向 scripts/build-server.sh）",
    );
  }

  const scriptExists = lines.length > 1 &&
    lines[0]?.startsWith("#!/usr/bin/env bash");
  if (!scriptExists) {
    problems.push("build-server.sh 缺少 shebang（#!/usr/bin/env bash）");
  }
  return problems;
}

if (import.meta.main) {
  const problems = verifyBuildServerScript();
  if (problems.length > 0) {
    console.error("❌ noj-server 构建门禁失败：\n- " + problems.join("\n- "));
    Deno.exit(1);
  }
  console.log("✅ noj-server 构建脚本门禁通过");
}
