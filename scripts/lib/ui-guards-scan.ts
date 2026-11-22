/**
 * noj-ui 设计系统守卫：三个作用域的定义与 `.vue` 扫描。
 *
 * 数字口径：**命中次数**，不是文件数——一处 `rounded-xl` 就是一笔债务，
 * 按文件计会让"同一文件里再加三处"静默通过。
 */

import {
  detect,
  RULE_NAMES,
  type RuleName,
  zeroCounts,
} from "./ui-guards-rules.ts";

export type ScopeName = "s1" | "public" | "all";

export const SCOPE_NAMES: readonly ScopeName[] = ["s1", "public", "all"];

/** 报告与提示里的 scope 名。 */
export const SCOPE_LABELS: Record<ScopeName, string> = {
  s1: "S1",
  public: "public",
  all: "all",
};

/**
 * S1（首要治理域）的豁免清单——即本阶段划给 S2 的板块。
 *
 * 2026-11-21 按目录重命名校准：`uiproblem/` → `problem/ui/`；
 * `d/[slug]/settings/**`（工作区设置页）与 `d/[slug]/problems/new.vue`
 * （新建题目页）补入；`messages/**` 随 v0.11 私信功能下线删除。
 * `problems/new/**` 保留：它仍覆盖旧版全局建题向导
 * `pages/problems/new/{index,bundle,coding,oi}.vue`。
 * 这些板块仍**计入 `all`**（只统计、不设目标）。
 */
export const S1_EXCLUDES: readonly string[] = [
  "**/admin/**",
  "**/layouts/admin.vue",
  "**/editor/**",
  "**/problem/ui/**",
  "**/objective/**",
  "**/settings.vue",
  "**/d/[slug]/settings/**",
  "**/my/**",
  "**/problems/new/**",
  "**/d/[slug]/problems/new.vue",
  "**/edit.vue",
];

/** public = pages + components，排除 admin。 */
export const PUBLIC_EXCLUDES: readonly string[] = ["**/admin/**"];

/** 只排除构建产物与依赖目录；其余目录一律扫描。 */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".nuxt",
  ".output",
  "dist",
  "test-results",
]);

/** 把 glob 编译成正则：`**` 跨目录、`*` 段内、`?` 单字符。 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:[^/]+/)*";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

const S1_EXCLUDE_RES = S1_EXCLUDES.map(globToRegExp);
const PUBLIC_EXCLUDE_RES = PUBLIC_EXCLUDES.map(globToRegExp);

/** 相对 `noj-ui/` 的路径是否属于某个作用域。 */
export function inScope(scope: ScopeName, relPath: string): boolean {
  if (scope === "all") return true;
  if (scope === "public") {
    const inArea = relPath.startsWith("pages/") ||
      relPath.startsWith("components/");
    return inArea && !PUBLIC_EXCLUDE_RES.some((re) => re.test(relPath));
  }
  return !S1_EXCLUDE_RES.some((re) => re.test(relPath));
}

export interface ScopeScan {
  /** 该作用域内的 `.vue` 文件数（仅展示，不进基线——新增文件不该触发棘轮）。 */
  files: number;
  counts: Record<RuleName, number>;
}

export type Scan = Record<ScopeName, ScopeScan>;

/** 统一成正斜杠路径（Windows 反斜杠会让 glob 与文件读取对不上）。 */
export function toPosix(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

/** 收集 `noj-ui/` 下所有 `.vue`（相对路径，正斜杠）。 */
export async function collectVueFiles(root: string): Promise<string[]> {
  const base = toPosix(root);
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    // Deno.readDir 是惰性 async iterable：目录不存在在迭代时才抛，必须包住整个循环。
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) entries.push(entry);
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(`${dir}/${entry.name}`, childRel);
      } else if (entry.isFile && entry.name.endsWith(".vue")) {
        out.push(childRel);
      }
    }
  }
  await walk(`${base}/noj-ui`, "");
  // 排序只为可复现；计数与顺序无关。
  return out.sort();
}

function emptyScan(): Scan {
  const scan = {} as Scan;
  for (const scope of SCOPE_NAMES) {
    scan[scope] = { files: 0, counts: zeroCounts() };
  }
  return scan;
}

/** 扫描一个仓库根（期望其下有 `noj-ui/`），返回三 scope 的计数。 */
export async function scanUi(root: string): Promise<Scan> {
  const base = toPosix(root);
  const scan = emptyScan();
  for (const rel of await collectVueFiles(base)) {
    let source: string;
    try {
      source = await Deno.readTextFile(`${base}/noj-ui/${rel}`);
    } catch {
      continue;
    }
    const counts = detect(source);
    for (const scope of SCOPE_NAMES) {
      if (!inScope(scope, rel)) continue;
      scan[scope].files++;
      for (const rule of RULE_NAMES) scan[scope].counts[rule] += counts[rule];
    }
  }
  return scan;
}
