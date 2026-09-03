/**
 * 迁移辅助：把旧文件路径改写为新文件路径。
 *
 * 用法（在仓库根运行）：
 *   deno run -A scripts/rewrite-imports.ts noj-core/src/lib/errors.ts noj-core/src/shared/base/errors.ts
 *
 * 会扫描 noj-core/src、noj-core/tests、noj-core/scripts 下的 .ts 文件，
 * 找到“相对导入解析后等于旧绝对路径”的 import/export spec，替换为
 * 指向新绝对路径的相对 spec。
 */
import { dirname, relative, resolve, sep } from "node:path";

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

async function collectTsFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(current: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      const full = `${current}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(full);
      } else if (entry.isFile && entry.name.endsWith(".ts")) {
        results.push(full);
      }
    }
  }
  try {
    const stat = await Deno.stat(dir);
    if (!stat.isDirectory) return [];
  } catch {
    return [];
  }
  await walk(dir);
  return results;
}

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+[\s\S]*?from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

async function rewriteImport(oldAbs: string, newAbs: string): Promise<number> {
  const oldTarget = toPosix(resolve(oldAbs));
  const newTarget = toPosix(resolve(newAbs));
  const roots = ["noj-core/src", "noj-core/tests", "noj-core/scripts"].map(
    (root) => resolve(root),
  );
  let changedFiles = 0;

  for (const root of roots) {
    for (const file of await collectTsFiles(root)) {
      const content = await Deno.readTextFile(file);
      const specs = new Set<string>();
      for (const m of content.matchAll(IMPORT_RE)) {
        if (m[1]) specs.add(m[1]);
      }
      for (const m of content.matchAll(DYNAMIC_IMPORT_RE)) {
        if (m[1]) specs.add(m[1]);
      }

      let updated = content;
      for (const spec of specs) {
        if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
        const target = toPosix(resolve(dirname(file), spec));
        if (target === oldTarget) {
          const newSpec = "./" + toPosix(relative(dirname(file), newTarget));
          updated = updated.split(`"${spec}"`).join(`"${newSpec}"`);
          updated = updated.split(`'${spec}'`).join(`'${newSpec}'`);
        }
      }
      if (updated !== content) {
        await Deno.writeTextFile(file, updated);
        changedFiles++;
        console.log(`updated ${file}`);
      }
    }
  }
  return changedFiles;
}

if (import.meta.main) {
  if (Deno.args.length !== 2) {
    console.error(
      "用法: deno run -A scripts/rewrite-imports.ts <oldAbsPath> <newAbsPath>",
    );
    Deno.exit(1);
  }
  const count = await rewriteImport(Deno.args[0]!, Deno.args[1]!);
  console.log(`重写完成，修改 ${count} 个文件`);
}
