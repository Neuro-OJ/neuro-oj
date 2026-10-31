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

/**
 * 提取 `deno compile --include <path>` 中的路径（相对 noj-core）。
 *
 * @param text 构建脚本或 Dockerfile 全文
 * @returns 出现过的 include 路径
 */
export function extractCompileIncludes(text: string): string[] {
  return [...text.matchAll(/--include\s+(\S+)/g)].map((m) => m[1]);
}

/**
 * 校验 include 路径都真实存在：`deno compile` 遇到缺失路径会直接失败，
 * 模块迁移后遗漏同步会让生产镜像无法构建（#698 P1-3 发现）。
 *
 * @param label 来源文件名，用于报错
 * @param text 文件全文
 * @param exists 路径存在性判断（可注入以便测试）
 * @returns 问题清单
 */
export function verifyCompileIncludes(
  label: string,
  text: string,
  exists: (rel: string) => boolean = (rel) => {
    try {
      Deno.statSync(path.join(ROOT, "noj-core", rel));
      return true;
    } catch {
      return false;
    }
  },
): string[] {
  return extractCompileIncludes(text)
    .filter((rel) => !exists(rel))
    .map((rel) => `${label} 的 deno compile --include 路径不存在：${rel}`);
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

  problems.push(...verifyCompileIncludes("build-server.sh", joined));
  problems.push(
    ...verifyCompileIncludes(
      "noj-core/Dockerfile",
      Deno.readTextFileSync(path.join(ROOT, "noj-core/Dockerfile")),
    ),
  );

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
