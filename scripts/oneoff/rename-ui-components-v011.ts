/**
 * 一次性迁移脚本 v0.11：按 dev-docs/refactor/2026-11-21-ui-component-map-v011.md
 * 移动/重命名 noj-ui 组件，并改写 import、模板标签与组件测试 stub 键。
 *
 * 用法（仓库根执行）：
 *   deno run -A scripts/oneoff/rename-ui-components-v011.ts            # dry-run，只打印计划与校验
 *   deno run -A scripts/oneoff/rename-ui-components-v011.ts --apply    # 真正移动并改写
 *
 * 与 rc0.10 脚本（scripts/oneoff/rename-ui-components.ts）的差异：
 * 1. 只解析文档 §3 的映射表，统计表 / 冲突表不会被误读。
 * 2. 标签改写只作用于 .vue 的模板区（跳过 <script>/<style>)：本分支有
 *    `Partial<DomainAiRuntime>` 这类 TS 泛型，整文件替换会把类型名改坏。
 * 3. 同步 tests 目录下 .ts 文件里按组件名打桩的 stub 键与 name 字段。
 * 4. 明确跳过 nuxt.config.ts（显式 dirs 留到下一轮）；labRegistry 不存在则跳过。
 * 5. dry-run 即使有阻断项也打印完整计划，退出码 2 表示「计划有冲突」，1 表示输入/覆盖校验失败。
 *
 * 设计约束：
 * - 映射表是唯一真相源，脚本不推断名字；表里没有的组件一律不碰。
 * - 幂等：重复执行 --apply 时，已移动的旧路径不存在会在预检阶段报错退出，不会半途改坏。
 */
import { basename, dirname, join, relative, sep } from "node:path";

const REPO_ROOT = Deno.cwd();
const UI_ROOT = join(REPO_ROOT, "noj-ui");
const COMPONENTS_ROOT = join(UI_ROOT, "components");
const DOC_PATH = join(
  REPO_ROOT,
  "dev-docs/refactor/2026-11-21-ui-component-map-v011.md",
);
const LAB_REGISTRY = join(UI_ROOT, "utils/labRegistry.ts");
const NUXT_CONFIG = join(UI_ROOT, "nuxt.config.ts");
const SKIP_DIRS = new Set([
  ".output",
  ".nuxt",
  "node_modules",
  "dist",
  ".git",
  "public",
  "coverage",
]);

type Action = "原地" | "移动" | "改名" | "移动+改名" | "冻结";

interface Mapping {
  oldRel: string;
  newRel: string;
  docAction: string;
  action: Action;
  oldTag: string;
  newTag: string;
}

interface Hit {
  file: string;
  count: number;
}

const BLOCK_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;

function toPosix(p: string, base = REPO_ROOT): string {
  return relative(base, p).split(sep).join("/");
}

async function walk(
  dir: string,
  exts: string[],
  out: string[] = [],
): Promise<string[]> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), exts, out);
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function stripCodeBlocks(content: string): string {
  let out = "";
  let last = 0;
  for (const match of content.matchAll(BLOCK_RE)) {
    out += content.slice(last, match.index);
    last = match.index + match[0].length;
  }
  return out + content.slice(last);
}

function actionOf(oldRel: string, newRel: string): Action {
  if (oldRel === newRel) return "原地";
  const sameDir = dirname(oldRel) === dirname(newRel);
  const sameName = basename(oldRel) === basename(newRel);
  if (sameDir) return "改名";
  if (sameName) return "移动";
  return "移动+改名";
}

function stripCell(cell: string): string {
  return cell.trim().replace(/^`/, "").replace(/`$/, "").trim();
}

/** 只解析「## 3. 映射表」到「## 4.」之间的表格行。 */
function parseMapping(doc: string): Mapping[] {
  const start = doc.indexOf("## 3. 映射表");
  const end = doc.indexOf("## 4. 命名例外");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("文档中找不到 §3 映射表或 §4 边界");
  }
  const section = doc.slice(start, end);
  const rows: Mapping[] = [];
  const seen = new Set<string>();
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("| `")) continue;
    const cells = line.split("|");
    if (cells.length < 5) continue;
    const oldRel = stripCell(cells[1]);
    const newRaw = stripCell(cells[2]);
    if (!oldRel.endsWith(".vue")) continue;
    const newRel = newRaw === "同左" ? oldRel : newRaw;
    if (!newRel.endsWith(".vue")) continue;
    if (seen.has(oldRel)) {
      throw new Error(`映射表旧路径重复：${oldRel}`);
    }
    seen.add(oldRel);
    rows.push({
      oldRel,
      newRel,
      docAction: cells[3].trim(),
      action: actionOf(oldRel, newRel),
      oldTag: basename(oldRel, ".vue"),
      newTag: basename(newRel, ".vue"),
    });
  }
  return rows;
}

function rewriteImport(
  content: string,
  oldRel: string,
  newRel: string,
): string {
  if (oldRel === newRel) return content;
  return content
    .split(`"~/components/${oldRel}"`).join(`"~/components/${newRel}"`)
    .split(`'~/components/${oldRel}'`).join(`'~/components/${newRel}'`);
}

/** 模板区标签替换：<Old> / </Old> / <Old ...> / <Old/>，带边界。 */
function rewriteTags(content: string, renames: Mapping[]): string {
  if (renames.length === 0) return content;
  return replaceOutsideBlocks(content, renames);
}

/**
 * 单次正则同时替换全部旧标签，避免 A→B、B→C 这类链被顺序执行二次改名。
 * 例：`<DomainSubmissionResult>` 与 `<SubmissionResult>` 要互换类映射，必须一次完成。
 */
function applyTagRenames(segment: string, renames: Mapping[]): string {
  if (renames.length === 0) return segment;
  const targets = new Map(renames.map((row) => [row.oldTag, row.newTag]));
  const pattern = [...targets.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const re = new RegExp(`<(/?)(${pattern})(?=[\\s/>])`, "g");
  return segment.replace(
    re,
    (_match, slash: string, tag: string) => `<${slash}${targets.get(tag)}`,
  );
}

function replaceOutsideBlocks(content: string, renames: Mapping[]): string {
  const parts: string[] = [];
  let last = 0;
  for (const match of content.matchAll(BLOCK_RE)) {
    parts.push(applyTagRenames(content.slice(last, match.index), renames));
    parts.push(match[0]);
    last = match.index + match[0].length;
  }
  parts.push(applyTagRenames(content.slice(last), renames));
  return parts.join("");
}

/** 组件测试 stub：行首 `OldTag:` 对象键 + `name: 'OldTag'`（含 findComponent({ name })）。 */
function rewriteStubKeys(content: string, renames: Mapping[]): string {
  if (renames.length === 0) return content;
  const targets = new Map(renames.map((row) => [row.oldTag, row.newTag]));
  const pattern = [...targets.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  let out = content.replace(
    new RegExp(`^(\\s+)(${pattern}):`, "gm"),
    (_match, indent: string, tag: string) => `${indent}${targets.get(tag)}:`,
  );
  out = out.replace(
    new RegExp(`name:\\s*(['"])(${pattern})\\1`, "g"),
    (_match, quote: string, tag: string) =>
      `name: ${quote}${targets.get(tag)}${quote}`,
  );
  return out;
}

/**
 * .vue 里显式 `import OldTag from '~/components/<newRel>'` 的本地绑定名跟着新标签改。
 * 否则模板标签改成 <NewTag> 后，旧绑定变成未使用变量，标签只能靠自动导入解析。
 * 只处理「绑定名 == 旧标签名」的情况（本表 12 个 .vue 全部如此）。
 * 同样用单次正则替换，避免 C1 的 `SubmissionResult` ↔ `SubmissionStatusBadge` 链。
 */
function rewriteVueBindings(content: string, renames: Mapping[]): string {
  const targets = new Map<string, string>();
  for (const mapping of renames) {
    const importRe = new RegExp(
      `import\\s+${mapping.oldTag}(?:\\s*,\\s*\\{[\\s\\S]*?\\})?\\s*from\\s*['"]~/components/${
        escapeRegExp(mapping.newRel)
      }['"]`,
    );
    if (importRe.test(content)) targets.set(mapping.oldTag, mapping.newTag);
  }
  if (targets.size === 0) return content;
  const pattern = [...targets.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  return content.replace(
    new RegExp(`\\b(${pattern})\\b`, "g"),
    (tag: string) => targets.get(tag) ?? tag,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main(): Promise<void> {
  const apply = Deno.args.includes("--apply");
  const unknown = Deno.args.filter((arg) => arg !== "--apply");
  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join(" ")}（只接受 --apply）`);
    Deno.exit(1);
  }

  const doc = await Deno.readTextFile(DOC_PATH);
  const mapping = parseMapping(doc);
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. 覆盖性：components/ 下每个 .vue 都必须在表里（legacy/ 不参与自动导入）。
  const onDiskAbs = await walk(COMPONENTS_ROOT, [".vue"]);
  const onDisk = onDiskAbs.map((path) => toPosix(path, COMPONENTS_ROOT)).sort();
  const importable = onDisk.filter((rel) => !rel.startsWith("legacy/"));

  // 0. 幂等：已经全部迁移过（目标都在、会动的旧路径都不在）就直接结束。
  const diskLookup = new Set(onDisk);
  const allTargetsPresent = mapping.every((row) =>
    row.oldRel === row.newRel
      ? diskLookup.has(row.oldRel)
      : diskLookup.has(row.newRel)
  );
  const anyMovingSourcePresent = mapping.some((row) =>
    row.oldRel !== row.newRel && diskLookup.has(row.oldRel)
  );
  if (allTargetsPresent && !anyMovingSourcePresent) {
    console.log(
      "检测到迁移已执行（旧路径均不存在、目标路径均存在），无需改动。",
    );
    return;
  }

  const mappedOld = new Set(mapping.map((row) => row.oldRel));
  const unmapped = importable.filter((rel) => !mappedOld.has(rel));
  const missing = mapping.filter((row) =>
    row.oldRel !== row.newRel && !onDisk.includes(row.oldRel) &&
    !(row.newRel.startsWith("legacy/") && onDisk.includes(row.newRel))
  );
  for (const rel of unmapped) errors.push(`未映射：components/${rel}`);
  for (const row of missing) {
    errors.push(`源文件不存在：components/${row.oldRel}`);
  }

  // 2. 目标路径唯一（legacy/ 不占用组件名）。
  const targetGroups = new Map<string, Mapping[]>();
  for (const row of mapping) {
    if (row.newRel.startsWith("legacy/")) continue;
    const key = row.newRel.toLowerCase();
    if (!targetGroups.has(key)) targetGroups.set(key, []);
    targetGroups.get(key)!.push(row);
  }
  const targetConflicts = [...targetGroups.values()].filter((rows) =>
    rows.length > 1
  );
  for (const rows of targetConflicts) {
    const detail = rows.map((row) => `${row.oldRel} → ${row.newRel}`).join(
      "；",
    );
    errors.push(
      `目标重复：components/${rows[0].newRel} ×${rows.length}（${detail}）`,
    );
  }

  // 3. 新标签唯一（大小写不敏感，Windows 文件系统）。
  const tagGroups = new Map<string, Mapping[]>();
  for (const row of mapping) {
    if (row.newRel.startsWith("legacy/")) continue;
    if (!tagGroups.has(row.newTag.toLowerCase())) {
      tagGroups.set(row.newTag.toLowerCase(), []);
    }
    tagGroups.get(row.newTag.toLowerCase())!.push(row);
  }
  const tagConflicts = [...tagGroups.values()].filter((rows) =>
    rows.length > 1 && new Set(rows.map((row) => row.newRel)).size > 1
  );
  for (const rows of tagConflicts) {
    errors.push(
      `标签重复：<${rows[0].newTag}> ×${rows.length}（${
        rows.map((row) => row.oldRel).join("、")
      }）`,
    );
  }

  // 4. 目标被现有文件占用 / 移动链。
  const diskSet = new Set(onDisk);
  const movingSources = new Set(
    mapping.filter((row) => row.oldRel !== row.newRel).map((row) => row.oldRel),
  );
  for (const row of mapping) {
    if (row.oldRel === row.newRel) continue;
    if (diskSet.has(row.newRel) && !movingSources.has(row.newRel)) {
      errors.push(
        `目标已存在：components/${row.newRel}（来自 ${row.oldRel}）`,
      );
    }
    if (
      mapping.some((other) =>
        other.oldRel === row.newRel && other.oldRel !== other.newRel
      )
    ) {
      errors.push(`移动链：${row.oldRel} → ${row.newRel} → …，需人工排序`);
    }
  }

  // 5. 标签替换链：A→B 且 B→C 时顺序替换会二次改名；本脚本用单次正则处理，仅提示。
  const renames = mapping.filter((row) => row.oldTag !== row.newTag);
  for (const row of renames) {
    if (renames.some((other) => other !== row && other.oldTag === row.newTag)) {
      warnings.push(
        `改名链：<${row.oldTag}> → <${row.newTag}>，且 <${row.newTag}> 另有改名项；已用单次替换规避`,
      );
    }
  }

  // 6. 文档动作与路径推导不一致时告警（不阻断）。
  for (const row of mapping) {
    if (row.docAction && row.docAction !== row.action) {
      warnings.push(
        `动作不一致：${row.oldRel} 文档写「${row.docAction}」，按路径应为「${row.action}」`,
      );
    }
  }

  // 7. 扫描引用：import / 模板标签 / 测试 stub。
  const contentAbs = (await walk(UI_ROOT, [".vue", ".ts"]))
    .filter((path) => path !== NUXT_CONFIG);
  const contents = new Map<string, string>();
  for (const path of contentAbs) {
    contents.set(path, await Deno.readTextFile(path));
  }

  const importHits = new Map<string, number>();
  const templateHits = new Map<string, number>();
  const scriptHits = new Map<string, Hit[]>();
  const stubHits = new Map<string, number>();
  let changedFiles = 0;

  for (const [path, text] of contents) {
    const rel = toPosix(path, UI_ROOT);
    const isVue = path.endsWith(".vue");
    const outside = isVue ? stripCodeBlocks(text) : text;
    let touched = false;

    for (const row of mapping) {
      if (row.oldRel === row.newRel) continue;
      const needleDouble = `"~/components/${row.oldRel}"`;
      const needleSingle = `'~/components/${row.oldRel}'`;
      const count = text.split(needleDouble).length - 1 +
        text.split(needleSingle).length - 1;
      if (count > 0) {
        importHits.set(row.oldRel, (importHits.get(row.oldRel) ?? 0) + count);
        touched = true;
      }
    }

    if (isVue) {
      for (const row of renames) {
        const re = new RegExp(`<(/?)${row.oldTag}(?=[\\s/>])`, "g");
        const total = (text.match(re) ?? []).length;
        if (total === 0) continue;
        const inTemplate = (outside.match(re) ?? []).length;
        if (inTemplate > 0) {
          templateHits.set(
            row.oldTag,
            (templateHits.get(row.oldTag) ?? 0) + inTemplate,
          );
          touched = true;
        }
        const inScript = total - inTemplate;
        if (inScript > 0) {
          if (!scriptHits.has(row.oldTag)) scriptHits.set(row.oldTag, []);
          scriptHits.get(row.oldTag)!.push({ file: rel, count: inScript });
        }
      }
    }

    if (rel.startsWith("tests/") && path.endsWith(".ts")) {
      for (const row of renames) {
        const keyRe = new RegExp(`^\\s+${row.oldTag}:`, "gm");
        const nameRe = new RegExp(`name:\\s*['"]${row.oldTag}['"]`, "g");
        const count = (text.match(keyRe) ?? []).length +
          (text.match(nameRe) ?? []).length;
        if (count > 0) {
          stubHits.set(row.oldTag, (stubHits.get(row.oldTag) ?? 0) + count);
          touched = true;
        }
      }
    }

    if (touched) changedFiles++;
  }

  // 8. 统计与计划。
  const actions = new Map<Action, number>();
  for (const row of mapping) {
    actions.set(row.action, (actions.get(row.action) ?? 0) + 1);
  }
  const dirCounts = new Map<string, number>();
  for (const row of mapping) {
    const top = row.newRel.split("/")[0] || "(root)";
    dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
  }
  const moves = mapping.filter((row) => row.oldRel !== row.newRel);

  console.log(
    "noj-ui 组件迁移 v0.11" + (apply ? "（--apply）" : "（dry-run）"),
  );
  console.log(`文档：${toPosix(DOC_PATH)}`);
  console.log(
    `映射 ${mapping.length} 行；磁盘组件 ${onDisk.length}；可自动导入 ${importable.length}；覆盖 ${
      importable.length - unmapped.length
    }`,
  );
  console.log(
    `动作：原地 ${actions.get("原地") ?? 0} · 移动 ${
      actions.get("移动") ?? 0
    } · 改名 ${actions.get("改名") ?? 0} · 移动+改名 ${
      actions.get("移动+改名") ?? 0
    } · 冻结 ${actions.get("冻结") ?? 0}`,
  );
  console.log(
    "目录：" +
      [...dirCounts.entries()].sort().map(([dir, count]) => `${dir} ${count}`)
        .join(" · "),
  );
  console.log(
    `目标路径唯一：${
      targetConflicts.length === 0
        ? "通过"
        : `失败（${targetConflicts.length} 组）`
    }`,
  );
  console.log(
    `目标标签唯一：${
      tagConflicts.length === 0 ? "通过" : `失败（${tagConflicts.length} 组）`
    }`,
  );
  console.log(`表外组件：${unmapped.length === 0 ? "0" : unmapped.length}`);
  console.log(
    `引用扫描：需改写 ${changedFiles} 文件（import ${
      [...importHits.values()].reduce((a, b) => a + b, 0)
    } 行、模板标签 ${
      [...templateHits.values()].reduce((a, b) => a + b, 0)
    } 处、测试 stub ${[...stubHits.values()].reduce((a, b) => a + b, 0)} 处）`,
  );

  if (!apply) {
    console.log(
      `\n[dry-run] 路径变化 ${moves.length} 个文件（纯移动 ${
        actions.get("移动") ?? 0
      } / 仅改名 ${actions.get("改名") ?? 0} / 移动+改名 ${
        actions.get("移动+改名") ?? 0
      }）：`,
    );
    for (const row of moves) {
      console.log(`  ${row.oldRel} → ${row.newRel}`);
    }
    console.log(`\n[dry-run] 改名 ${renames.length} 项（受影响引用）：`);
    for (const row of renames) {
      console.log(
        `  <${row.oldTag}> → <${row.newTag}>（模板 ${
          templateHits.get(row.oldTag) ?? 0
        } 处 / stub ${stubHits.get(row.oldTag) ?? 0} 处 / import ${
          importHits.get(row.oldRel) ?? 0
        } 行）`,
      );
    }

    const emptyDirs = new Set<string>();
    const remaining = new Set(
      importable.filter((rel) => !movingSources.has(rel)),
    );
    for (const row of moves) {
      const dir = dirname(row.oldRel);
      if (dir === ".") continue;
      if (![...remaining].some((rel) => dirname(rel) === dir)) {
        emptyDirs.add(dir);
      }
    }
    if (emptyDirs.size > 0) {
      console.log("\n迁移后可能变空的目录（脚本不删除）：");
      for (const dir of [...emptyDirs].sort()) {
        console.log(`  components/${dir}/`);
      }
    }

    if (scriptHits.size > 0) {
      console.log("\n⚠ <script>/<style> 内的同名标记（已跳过，需人工确认）：");
      for (const [tag, hits] of scriptHits) {
        for (const hit of hits) {
          console.log(`  <${tag}> ×${hit.count} @ ${hit.file}`);
        }
      }
    }
  }

  if (warnings.length > 0) {
    console.log("\n告警（不阻断）：");
    for (const warning of warnings) console.log(`  - ${warning}`);
  }

  if (errors.length > 0) {
    console.error(`\n校验失败（${errors.length} 条）：`);
    for (const error of errors) console.error(`  - ${error}`);
    console.error(
      apply
        ? "\n未执行任何修改。修表后重跑。"
        : "\n[dry-run] 计划已生成但存在阻断项；修表后重跑，退出码 2。",
    );
    Deno.exit(apply ? 1 : 2);
  }

  if (!apply) {
    console.log("\n未执行任何修改。加 --apply 才写入。");
    return;
  }

  // 9. --apply：先改写内容，再移动文件（contents 以旧路径为键）。
  let rewritten = 0;
  for (const [path, text] of contents) {
    let next = text;
    for (const row of mapping) {
      next = rewriteImport(next, row.oldRel, row.newRel);
    }
    if (path.endsWith(".vue")) {
      // 先改标签（单次替换），再改显式 import 的绑定名；顺序反过来会把
      // DomainSubmissionResult→SubmissionResult 的新标签再当成旧 SubmissionResult 改掉。
      next = rewriteTags(next, renames);
      next = rewriteVueBindings(next, renames);
    }
    if (toPosix(path, UI_ROOT).startsWith("tests/") && path.endsWith(".ts")) {
      next = rewriteStubKeys(next, renames);
    }
    if (next !== text) {
      await Deno.writeTextFile(path, next);
      rewritten++;
    }
  }

  // labRegistry 的键是组件名；本分支没有该文件时跳过。
  if (await exists(LAB_REGISTRY)) {
    let labText = await Deno.readTextFile(LAB_REGISTRY);
    const before = labText;
    for (const row of renames) {
      labText = labText.replace(
        new RegExp(`(^|\\n)(\\s+)${row.oldTag}(: \\{)`, "g"),
        `$1$2${row.newTag}$3`,
      );
    }
    if (labText !== before) await Deno.writeTextFile(LAB_REGISTRY, labText);
  }

  for (const row of moves) {
    const from = join(COMPONENTS_ROOT, row.oldRel);
    const to = join(COMPONENTS_ROOT, row.newRel);
    await Deno.mkdir(dirname(to), { recursive: true });
    await Deno.rename(from, to);
  }

  console.log(
    `\n完成：改写 ${rewritten} 个文件，移动 ${moves.length} 个文件。`,
  );
  console.log(
    "还需手工处理：nuxt.config.ts 的 components.dirs、noj-ui/AGENTS.md、空目录清理。",
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

await main();
