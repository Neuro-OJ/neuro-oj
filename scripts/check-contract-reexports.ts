/**
 * 跨模块合同门禁（2026-11-02 rc/v0.11 审计「区分隔离与转发层」）。
 *
 * 审计意见：`contracts/cross-module/` 里有 67 个文件，其中不少只是
 * `export { fn } from 实现` 的薄转发层——它们约束了导入图，但**不构成稳定业务
 * 合同**。继续按源文件复制合同文件，只会让"有合同"看起来等于"有边界"。
 *
 * 本门禁不阻止转发层（当前结构就是转发层），但要求每个**纯重导出**文件在
 * `scripts/contract-reexport-registry.json` 里登记它暴露的**稳定能力**与 DTO 说明，
 * 从而：
 * 1. 新增一个纯重导出文件必须写下"这是哪个能力/DTO"，而不是顺手复制；
 * 2. 已登记文件的能力描述可被审计，逐渐向"按能力组织少量合同"收敛。
 *
 * 含真实实现（函数体、类型定义）的合同文件不在此列。
 */
import { walk } from "jsr:@std/fs@^1";
import { relative, resolve } from "node:path";

/** 登记表结构。 */
export interface ContractRegistry {
  contracts: Record<
    string,
    { capability: string; dto?: string; note?: string }
  >;
}

/** 判断文件是否"只有重导出"（没有函数/类/常量实现）。 */
export function isPureReexport(source: string): boolean {
  const body = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .trim();
  if (!body) return false;
  // 逐个顶层 `export ... from "..."` 语句匹配；分号可有可无。
  const pattern =
    /export\s+(?:type\s+)?\{[\s\S]*?\}\s*from\s*["'][^"']+["']\s*;?|export\s+\*\s+from\s*["'][^"']+["']\s*;?/g;
  const matches = body.match(pattern) ?? [];
  if (matches.length === 0) return false;
  // 去掉全部匹配后必须只剩空白，否则说明文件里还有实现代码
  const rest = body.replace(pattern, "").trim();
  return rest === "";
}

/** 扫描合同目录，返回纯重导出文件（仓库相对路径）。 */
export async function collectPureReexports(
  root = ".",
): Promise<string[]> {
  const dir = resolve(root, "noj-core/src/modules");
  const found: string[] = [];
  for await (const entry of walk(dir, { exts: [".ts"], includeDirs: false })) {
    const file = relative(resolve(root), entry.path).replaceAll("\\", "/");
    if (!file.includes("/contracts/cross-module/")) continue;
    if (file.endsWith("/index.ts")) continue;
    const source = await Deno.readTextFile(entry.path);
    if (isPureReexport(source)) found.push(file);
  }
  return found.sort();
}

if (import.meta.main) {
  const registry = JSON.parse(
    await Deno.readTextFile("scripts/contract-reexport-registry.json"),
  ) as ContractRegistry;
  const files = await collectPureReexports(".");
  const missing = files.filter((file) => !(file in registry.contracts));
  const stale = Object.keys(registry.contracts).filter((file) =>
    !files.includes(file)
  );
  if (missing.length > 0) {
    console.error(
      `纯重导出合同未登记能力说明（${missing.length} 个）：`,
    );
    for (const file of missing) {
      console.error(
        `  ${file} —— 请在 scripts/contract-reexport-registry.json 写明 capability/dto，或改为按能力组织的合同`,
      );
    }
  }
  if (stale.length > 0) {
    console.error(`登记表里的文件已不再是纯重导出（${stale.length} 个）：`);
    for (const file of stale) console.error(`  ${file}`);
  }
  if (missing.length > 0 || stale.length > 0) Deno.exit(1);
  console.log(
    `跨模块合同检查通过（${files.length} 个纯重导出文件均已登记能力与 DTO）`,
  );
}
