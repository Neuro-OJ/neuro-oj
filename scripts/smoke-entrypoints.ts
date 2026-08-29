// 真实入口 Smoke。
// 检查各模块入口源文件存在；若已构建产物存在，则验证产物文件存在。
import { statSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname ?? ".", "..");

const SOURCE_ENTRIES = [
  { name: "noj-core", path: "noj-core/src/main.ts" },
  { name: "noj-ui", path: "noj-ui/package.json" },
  { name: "noj-judge", path: "noj-judge/Cargo.toml" },
  { name: "noj-llm-gateway", path: "noj-llm-gateway/src/main.ts" },
];

const BUILT_ENTRIES = [
  {
    name: "noj-ui compiled binary",
    path: "noj-ui/dist/noj-ui",
  },
  {
    name: "noj-judge release binary",
    path: "noj-judge/target/release/noj-judge",
  },
];

function exists(rel: string): boolean {
  try {
    return statSync(resolve(ROOT, rel)).isFile();
  } catch {
    return false;
  }
}

if (import.meta.main) {
  console.log("== 源码入口检查 ==");
  for (const entry of SOURCE_ENTRIES) {
    if (!exists(entry.path)) {
      console.error(`FAIL: ${entry.name} 入口缺失 ${entry.path}`);
      Deno.exit(1);
    }
    console.log(`OK: ${entry.name} ${entry.path}`);
  }

  console.log("== 已构建产物检查 ==");
  for (const entry of BUILT_ENTRIES) {
    if (!exists(entry.path)) {
      console.log(`SKIP: ${entry.name} 未构建（${entry.path}）`);
      continue;
    }
    // 当前只验证产物存在；执行 smoke 需要安全参数/超时，后续里程碑补充。
    console.log(`OK: ${entry.name} 已构建（${entry.path}）`);
  }

  console.log("入口 smoke 完成");
}
