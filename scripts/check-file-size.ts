/**
 * 单文件规模棘轮门禁（2026-09-12 架构评审 §3.2）。
 *
 * 背景：评审指出巨型文件仍在增长（`noj-judge/src/dual/mod.rs` 从 1662 涨到 2146 行），
 * 上一版评审的拆分建议未落实。单纯的"告警"不解决问题（告警会被忽略），因此这里用
 * **棘轮（ratchet）**：存量超限文件登记当且规模，**任何增长即失败**；新文件超过阈值
 * 直接失败；文件缩小后要求下调登记值（逐步偿还）。
 *
 * 阈值 1200 行：低于此值的文件不参与（避免噪声），高于此值的必须登记。
 *
 * 自检：扫描不到任何源文件 → 判定门禁失效。
 */

/** 单文件行数阈值。 */
export const MAX_LINES = 1200;

/**
 * 存量超限文件（棘轮基线）。
 *
 * 数值 = 本门禁建立时的实际行数；**只允许下调，不允许上调**。
 * 拆分后请把数值改成新的实际行数（或直接删除条目）。
 */
export const SIZE_BASELINE: Record<string, number> = {
  "noj-judge/src/dual/mod.rs": 2246,
  "noj-ui/pages/messages/index.vue": 1632,
  "noj-core/src/domains/messaging/services/messages.ts": 1515,
  "noj-core/src/shared/config/settings-registry.ts": 1360,
  "noj-core/src/domains/contest/services/contest-similarity.ts": 1315,
};

const SCAN_ROOTS = [
  "noj-core/src",
  "noj-ui",
  "noj-judge/src",
  "noj-llm-gateway/src",
  "noj-lmcc-extension/src",
  "noj-tests",
];

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".nuxt",
  ".output",
  "dist",
  "target",
  "coverage",
  ".test-cache",
  ".test-storage",
  "tests",
]);

const SOURCE_EXT = [".ts", ".vue", ".rs"];

export interface LargeFile {
  file: string;
  lines: number;
}

function isTestLike(name: string): boolean {
  return /(_test|\.test|\.spec)\.[a-z]+$/.test(name);
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    // 注意：Deno.readDir 是惰性 async iterable，"目录不存在"在迭代时才抛错，
    // 因此必须把 for await 本身放进 try（只在赋值处 try 是抓不到的）。
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) entries.push(entry);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(`${dir}/${entry.name}`);
      } else if (
        entry.isFile &&
        SOURCE_EXT.some((ext) => entry.name.endsWith(ext)) &&
        !isTestLike(entry.name)
      ) {
        out.push(`${dir}/${entry.name}`);
      }
    }
  }
  await walk(root);
  return out;
}

/** 统计行数（以 \n 计；末行无换行也计一行）。 */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lines++;
  }
  return lines;
}

export interface FileSizeResult {
  errors: string[];
  largeFiles: LargeFile[];
  stats: { scanned_files: number; over_threshold: number };
}

export async function checkFileSizes(
  root = ".",
  options: { checkStaleBaseline?: boolean } = {},
): Promise<FileSizeResult> {
  // 基线只对"真实仓库根"有意义；临时夹具目录（单测）不应触发陈旧条目检查
  const checkStale = options.checkStaleBaseline ?? root === ".";
  const errors: string[] = [];
  const files: string[] = [];
  for (const scanRoot of SCAN_ROOTS) {
    files.push(...await collectSourceFiles(`${root}/${scanRoot}`));
  }

  const largeFiles: LargeFile[] = [];
  for (const full of files) {
    const rel = full.replace(`${root}/`, "").replace(/^\.\//, "");
    let text: string;
    try {
      text = await Deno.readTextFile(full);
    } catch {
      continue;
    }
    const lines = countLines(text);
    if (lines > MAX_LINES) largeFiles.push({ file: rel, lines });
  }
  largeFiles.sort((a, b) => b.lines - a.lines);

  // 自检
  if (files.length === 0) {
    errors.push("未扫描到任何源文件（扫描根目录或过滤规则已失效）");
    return {
      errors,
      largeFiles,
      stats: { scanned_files: 0, over_threshold: 0 },
    };
  }

  const seen = new Set<string>();
  for (const entry of largeFiles) {
    seen.add(entry.file);
    const baseline = SIZE_BASELINE[entry.file];
    if (baseline === undefined) {
      errors.push(
        `${entry.file} 达到 ${entry.lines} 行（阈值 ${MAX_LINES}），且未登记基线——` +
          `请先拆分；确需保留请登记到 scripts/check-file-size.ts 的 SIZE_BASELINE 并说明原因`,
      );
      continue;
    }
    if (entry.lines > baseline) {
      errors.push(
        `${entry.file} 行数增长：基线 ${baseline} → 当前 ${entry.lines}（+${
          entry.lines - baseline
        }）——巨型文件不允许继续变大`,
      );
    } else if (entry.lines < baseline) {
      errors.push(
        `${entry.file} 已缩小到 ${entry.lines} 行（基线 ${baseline}），请下调 SIZE_BASELINE 以锁住成果`,
      );
    }
  }

  // 陈旧条目：已降到阈值以下的文件应从基线移除
  if (checkStale) {
    for (const file of Object.keys(SIZE_BASELINE)) {
      if (!seen.has(file)) {
        errors.push(
          `${file} 已不再超阈值（或已删除），请从 SIZE_BASELINE 中移除`,
        );
      }
    }
  }

  return {
    errors,
    largeFiles,
    stats: { scanned_files: files.length, over_threshold: largeFiles.length },
  };
}

if (import.meta.main) {
  const { errors, largeFiles, stats } = await checkFileSizes(".");
  if (Deno.args.includes("--print")) {
    console.log(
      JSON.stringify(
        Object.fromEntries(largeFiles.map((f) => [f.file, f.lines])),
        null,
        2,
      ),
    );
    Deno.exit(0);
  }
  if (errors.length > 0) {
    console.error("单文件规模检查失败：");
    for (const e of errors) console.error(`- ${e}`);
    Deno.exit(1);
  }
  const top = largeFiles.slice(0, 3).map((f) => `${f.file}=${f.lines}`).join(
    " ",
  );
  console.log(
    `单文件规模检查通过（扫描 ${stats.scanned_files} 个源文件 / 超阈值 ${stats.over_threshold} 个均已登记：${top}）`,
  );
}
