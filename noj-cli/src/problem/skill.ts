/**
 * `noj-cli problem skill`：把 AI 出题 Skill 写入出题仓库（P0-2 C）。
 *
 * 出题人通常在独立的题目仓库（或任意目录）里出题，主仓库内的 skill 在那里不会被
 * AI 编码助手加载；因此 Skill 随 noj-cli 分发，由本命令写到目标目录下各助手约定
 * 的位置：
 *   - `.agents/skills/noj-problem-setter/`（通用约定，Codex 等读取）
 *   - `.claude/skills/noj-problem-setter/`（Claude Code 读取）
 *
 * 写两份实体文件而非软链接：Windows 与部分同步工具不能可靠处理软链接。
 */
import { dirname, join } from "@std/path";
import { PROBLEM_SETTER_SKILL_FILES } from "./skill.generated.ts";

/** Skill 名（目录名，与 SKILL.md frontmatter 的 name 一致）。 */
export const PROBLEM_SETTER_SKILL_NAME = "noj-problem-setter";

/** 写入位置（相对目标目录）。 */
export const PROBLEM_SETTER_SKILL_ROOTS: readonly string[] = [
  ".agents/skills",
  ".claude/skills",
];

/** 单个写入位置的结果。 */
export interface SkillInstallTarget {
  /** Skill 目录绝对/相对路径（随入参）。 */
  dir: string;
  /** written：新写入或已覆盖；unchanged：内容已一致；conflict：已存在且不同（未写）。 */
  status: "written" | "unchanged" | "conflict";
}

/** 安装选项。 */
export interface SkillInstallOptions {
  /** 目标目录（出题仓库根）。 */
  root: string;
  /** 已存在且内容不同时覆盖（先删除旧目录，避免残留过期文件）。 */
  force?: boolean;
  /** 覆盖嵌入内容（测试用）。 */
  files?: Readonly<Record<string, string>>;
}

/** 读取一个已安装的 Skill 目录（不存在返回 null）。 */
async function readInstalled(
  dir: string,
): Promise<Record<string, string> | null> {
  try {
    if (!(await Deno.stat(dir)).isDirectory) return {};
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  const out: Record<string, string> = {};
  async function walk(current: string, prefix: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(current, entry.name);
      if (entry.isDirectory) await walk(path, rel);
      else if (entry.isFile) out[rel] = await Deno.readTextFile(path);
      // 其他条目（软链接等）记为不一致
      else out[rel] = "\0";
    }
  }
  await walk(dir, "");
  return out;
}

/** 两组文件是否完全一致。 */
function sameFiles(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length &&
    ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/**
 * 把 Skill 写入目标目录下的各约定位置。
 *
 * 已存在且内容不同的位置默认不动（status 为 conflict），需 `force` 才覆盖。
 */
export async function installProblemSetterSkill(
  opts: SkillInstallOptions,
): Promise<SkillInstallTarget[]> {
  const files = opts.files ?? PROBLEM_SETTER_SKILL_FILES;
  const results: SkillInstallTarget[] = [];
  for (const base of PROBLEM_SETTER_SKILL_ROOTS) {
    const dir = join(opts.root, base, PROBLEM_SETTER_SKILL_NAME);
    const installed = await readInstalled(dir);
    if (installed !== null && sameFiles(installed, files)) {
      results.push({ dir, status: "unchanged" });
      continue;
    }
    if (installed !== null && !opts.force) {
      results.push({ dir, status: "conflict" });
      continue;
    }
    if (installed !== null) await Deno.remove(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const path = join(dir, rel);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, content);
    }
    results.push({ dir, status: "written" });
  }
  return results;
}
