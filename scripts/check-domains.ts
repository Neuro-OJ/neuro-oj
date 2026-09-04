/**
 * noj-core 域边界静态检查。
 *
 * 扫描 src/domains/** 与遗留 src/services/** 的相对导入：
 * - 域内文件不得深路径 import 其他域的 services/routes；
 * - 允许 import 目标域门面 src/domains/<domain>/index.ts；
 * - shared/lib/db/types 等共享路径不检查。
 */
import { dirname, relative, resolve } from "node:path";

export interface DomainViolation {
  file: string;
  importSpec: string;
  target: string;
  message: string;
}

const DOMAINS = new Set([
  "identity",
  "catalog",
  "objective",
  "submission",
  "contest",
  "community",
  "messaging",
  "system",
  "gateway",
  "query",
  "content-review",
]);

const LEGACY_ALIASES: Record<string, string> = {
  auth: "identity",
  users: "identity",
  oauth: "identity",
  tfa: "identity",
  passwordReset: "identity",
  banlist: "identity",
  checkin: "identity",
  problems: "catalog",
  tags: "catalog",
  trainings: "catalog",
  "support-package": "catalog",
  submissions: "submission",
  queue: "submission",
  "self-tests": "submission",
  contest: "contest",
  community: "community",
  notifications: "community",
  messages: "messaging",
  objective: "objective",
  "system-settings": "system",
  announcements: "system",
  "audit-log": "system",
  seed: "system",
  llm: "gateway",
  search: "query",
  rankings: "query",
  "stats-cache": "query",
  dashboard: "query",
};

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+[\s\S]*?from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

export function domainOf(file: string): string | null {
  const p = toPosix(file);
  const domainsMatch = p.match(/^(?:noj-core\/)?src\/domains\/([^/]+)\//);
  if (domainsMatch && DOMAINS.has(domainsMatch[1]!)) {
    return domainsMatch[1]!;
  }
  const servicesDir = p.match(/^(?:noj-core\/)?src\/services\/([^/]+)\//);
  if (servicesDir) {
    return LEGACY_ALIASES[servicesDir[1]!] ?? null;
  }
  const servicesFile = p.match(/^(?:noj-core\/)?src\/services\/([^/]+)\.ts$/);
  if (servicesFile) {
    return LEGACY_ALIASES[servicesFile[1]!] ?? null;
  }
  return null;
}

export function resolveRelativeImport(
  file: string,
  spec: string,
  root = ".",
): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) {
    return null;
  }
  const absSource = resolve(root, file);
  const absTarget = resolve(dirname(absSource), spec);
  const rel = relative(resolve(root), absTarget);
  return toPosix(rel);
}

function isPublicDomainImport(target: string): boolean {
  const m = toPosix(target).match(
    /^(?:noj-core\/)?src\/domains\/([^/]+)\/index\.ts$/,
  );
  return m ? DOMAINS.has(m[1]!) : false;
}

export function checkFile(
  file: string,
  content: string,
  root = ".",
): DomainViolation[] {
  const sourceDomain = domainOf(file);
  if (!sourceDomain) return [];
  // 域内测试允许跨域深路径导入（集成场景常需构造其他域路由/数据），
  // 域边界规则仅约束生产代码。
  if (toPosix(file).includes("/tests/")) return [];

  const violations: DomainViolation[] = [];
  const specs = new Set<string>();

  for (const m of content.matchAll(IMPORT_RE)) {
    if (m[1]) specs.add(m[1]);
  }
  for (const m of content.matchAll(DYNAMIC_IMPORT_RE)) {
    if (m[1]) specs.add(m[1]);
  }

  for (const spec of specs) {
    const target = resolveRelativeImport(file, spec, root);
    if (!target) continue;
    const targetDomain = domainOf(target);
    if (!targetDomain || targetDomain === sourceDomain) continue;
    if (isPublicDomainImport(target)) continue;

    violations.push({
      file,
      importSpec: spec,
      target,
      message: `${sourceDomain} 域不得深路径导入 ${targetDomain} 域: ${spec}`,
    });
  }
  return violations;
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
  await walk(dir);
  return results;
}

export async function checkDomains(root = "."): Promise<DomainViolation[]> {
  const violations: DomainViolation[] = [];
  for (
    const dir of [
      "noj-core/src/domains",
      "noj-core/src/services",
      "src/domains",
      "src/services",
    ]
  ) {
    const absDir = resolve(root, dir);
    try {
      const stat = await Deno.stat(absDir);
      if (!stat.isDirectory) continue;
    } catch {
      continue;
    }
    const files = await collectTsFiles(absDir);
    for (const file of files) {
      const rel = toPosix(relative(resolve(root), file));
      if (!domainOf(rel)) continue;
      const content = await Deno.readTextFile(file);
      violations.push(...checkFile(rel, content, root));
    }
  }
  return violations;
}

/**
 * 检查 `src/shared/**` 不得反向依赖 `src/domains/**`。
 */
export async function checkSharedImports(
  root = ".",
): Promise<DomainViolation[]> {
  const violations: DomainViolation[] = [];
  const sharedDir = resolve(root, "noj-core/src/shared");
  try {
    const stat = await Deno.stat(sharedDir);
    if (!stat.isDirectory) return [];
  } catch {
    return [];
  }
  const files = await collectTsFiles(sharedDir);
  for (const file of files) {
    const rel = toPosix(relative(resolve(root), file));
    const content = await Deno.readTextFile(file);
    const specs = new Set<string>();
    for (const m of content.matchAll(IMPORT_RE)) {
      if (m[1]) specs.add(m[1]);
    }
    for (const m of content.matchAll(DYNAMIC_IMPORT_RE)) {
      if (m[1]) specs.add(m[1]);
    }
    for (const spec of specs) {
      const target = resolveRelativeImport(file, spec, root);
      if (!target) continue;
      if (target.startsWith("noj-core/src/domains/")) {
        violations.push({
          file: rel,
          importSpec: spec,
          target,
          message: `shared 不得反向依赖 domains: ${spec}`,
        });
      }
    }
  }
  return violations;
}

if (import.meta.main) {
  const args = Deno.args;
  const baselineIndex = args.indexOf("--baseline");
  const baselinePath = baselineIndex >= 0 ? args[baselineIndex + 1] : undefined;

  const violations = await checkDomains(".");
  const sharedViolations = await checkSharedImports(".");
  const all = [...violations, ...sharedViolations];

  if (baselinePath) {
    const baselineText = await Deno.readTextFile(baselinePath).catch(() => "");
    const baseline = new Set(
      baselineText.split("\n").map((s) => s.trim()).filter(Boolean),
    );
    const newViolations = all.filter(
      (v) => !baseline.has(`- ${v.file}: ${v.message}`),
    );
    if (newViolations.length > 0) {
      console.error(`发现 ${newViolations.length} 条新增域边界违规:`);
      for (const v of newViolations) {
        console.error(`- ${v.file}: ${v.message}`);
      }
      Deno.exit(1);
    }
    console.log("域边界检查通过（无新增违规）");
    Deno.exit(0);
  }

  if (all.length > 0) {
    console.error(`发现 ${all.length} 条域边界违规:`);
    for (const v of all) {
      console.error(`- ${v.file}: ${v.message}`);
    }
    Deno.exit(1);
  }
  console.log("域边界检查通过");
}
