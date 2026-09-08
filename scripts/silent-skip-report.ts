/**
 * 静默跳过扫描：找出测试中因 ignore/skip 与环境变量守卫而未真正执行的用例。
 */
export interface SkipHit {
  file: string;
  line: number;
  reason: "ignore" | "skip" | "env-guard";
}

export function scanFile(file: string, source: string): SkipHit[] {
  const hits: SkipHit[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\bignore\s*:\s*true\b/.test(line)) {
      hits.push({ file, line: i + 1, reason: "ignore" });
    }
    if (/\bignore\s*:\s*Deno\.env\.get/.test(line)) {
      hits.push({ file, line: i + 1, reason: "env-guard" });
    }
    if (/\bif\s*\(!?Deno\.env\.get\(/.test(line)) {
      hits.push({ file, line: i + 1, reason: "env-guard" });
    }
  }
  return hits;
}

export function renderReport(hits: SkipHit[]): string {
  const lines = ["# 静默跳过测试清单", "", "| 文件 | 行号 | 原因 |", "|---|---|---|"];
  for (const h of hits) {
    lines.push(`| ${h.file} | ${h.line} | ${h.reason} |`);
  }
  return lines.join("\n") + "\n";
}

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".nuxt",
  ".output",
  "dist",
  "coverage",
  ".deno_cov_cache",
  "target",
  ".git",
  ".jj",
]);

async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(`${dir}/${entry.name}`);
      } else if (entry.isFile && /(_test|\.test)\.ts$/.test(entry.name)) {
        out.push(`${dir}/${entry.name}`);
      }
    }
  }
  await walk(root);
  return out;
}

async function collectHits(): Promise<SkipHit[]> {
  const hits: SkipHit[] = [];
  const roots = ["noj-core", "noj-ui", "noj-llm-gateway", "noj-tests"];
  for (const root of roots) {
    for (const file of await collectFiles(root)) {
      const source = await Deno.readTextFile(file);
      hits.push(...scanFile(file, source));
    }
  }
  return hits;
}

if (import.meta.main) {
  const hits = await collectHits();
  const md = renderReport(hits);
  await Deno.writeTextFile("dev-docs/engineering/test-silent-skips.md", md);
  console.log(
    `静默跳过清单已写入 dev-docs/engineering/test-silent-skips.md（${hits.length} 处）`,
  );
}
