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
 *
 * 安全约束（defensive-patterns「删除 link-shaped path 用 lstat」）：
 *   - 目标目录之下的每一级路径组件（`.agents`、`skills`、Skill 目录）都先 `lstat`，
 *     任何一级是符号链接即拒绝，避免跟随链接写入或删除仓库之外的目录；
 *   - 先把新内容完整写进同级暂存目录，再整体替换旧目录；替换失败时还原旧目录，
 *     磁盘写满或中断不会留下半残的 Skill。
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

/** 校验 root 之下逐级路径组件都不是符号链接（不存在的组件到此为止）。 */
async function assertNoSymlinkComponents(
  root: string,
  parts: readonly string[],
): Promise<void> {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(current);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      throw err;
    }
    if (info.isSymlink) {
      throw new Error(
        `拒绝写入：${current} 是符号链接（可能指向目标目录之外），请改为普通目录后重试`,
      );
    }
    if (!info.isDirectory) {
      throw new Error(`拒绝写入：${current} 已存在且不是目录`);
    }
  }
}

/** 读取一个已安装的 Skill 目录（不存在返回 null；调用方已排除符号链接）。 */
async function readInstalled(
  dir: string,
): Promise<Record<string, string> | null> {
  try {
    await Deno.lstat(dir);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  const out: Record<string, string> = {};
  async function walk(current: string, prefix: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(current, entry.name);
      // DirEntry 不跟随链接：内部的软链接等特殊条目记为不一致，不读取其目标
      if (entry.isDirectory) await walk(path, rel);
      else if (entry.isFile) out[rel] = await Deno.readTextFile(path);
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

/** 尽力删除（清理暂存/备份目录用；Deno.remove 递归删除不跟随内部链接）。 */
async function removeQuietly(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch {
    // 已不存在或无法删除：不影响安装结果
  }
}

/** 把文件写入暂存目录，再整体替换 `dir`（旧目录存在时先挪作备份）。 */
async function stageAndSwap(
  parent: string,
  dir: string,
  files: Readonly<Record<string, string>>,
  replacing: boolean,
): Promise<void> {
  const stage = await Deno.makeTempDir({
    dir: parent,
    prefix: `.${PROBLEM_SETTER_SKILL_NAME}.staging-`,
  });
  try {
    if (Deno.build.os !== "windows") await Deno.chmod(stage, 0o755);
    for (const [rel, content] of Object.entries(files)) {
      const path = join(stage, rel);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, content);
    }
    if (!replacing) {
      await Deno.rename(stage, dir);
      return;
    }
    const backup = join(
      parent,
      `.${PROBLEM_SETTER_SKILL_NAME}.old-${crypto.randomUUID()}`,
    );
    await Deno.rename(dir, backup);
    try {
      await Deno.rename(stage, dir);
    } catch (err) {
      await Deno.rename(backup, dir);
      throw err;
    }
    await removeQuietly(backup);
  } catch (err) {
    await removeQuietly(stage);
    throw err;
  }
}

/**
 * 把 Skill 写入目标目录下的各约定位置。
 *
 * 已存在且内容不同的位置默认不动（status 为 conflict），需 `force` 才覆盖。
 * 路径中出现符号链接时抛错，不写入也不删除任何内容。
 */
export async function installProblemSetterSkill(
  opts: SkillInstallOptions,
): Promise<SkillInstallTarget[]> {
  const files = opts.files ?? PROBLEM_SETTER_SKILL_FILES;
  // 先校验全部位置再动手：任一位置不安全时两处都不写
  for (const base of PROBLEM_SETTER_SKILL_ROOTS) {
    await assertNoSymlinkComponents(opts.root, [
      ...base.split("/"),
      PROBLEM_SETTER_SKILL_NAME,
    ]);
  }
  const results: SkillInstallTarget[] = [];
  for (const base of PROBLEM_SETTER_SKILL_ROOTS) {
    const parts = base.split("/");
    const parent = join(opts.root, ...parts);
    const dir = join(parent, PROBLEM_SETTER_SKILL_NAME);
    const installed = await readInstalled(dir);
    if (installed !== null && sameFiles(installed, files)) {
      results.push({ dir, status: "unchanged" });
      continue;
    }
    if (installed !== null && !opts.force) {
      results.push({ dir, status: "conflict" });
      continue;
    }
    await Deno.mkdir(parent, { recursive: true });
    // mkdir 之后再查一次，缩小检查与写入之间被替换成链接的窗口
    await assertNoSymlinkComponents(opts.root, [
      ...parts,
      PROBLEM_SETTER_SKILL_NAME,
    ]);
    await stageAndSwap(parent, dir, files, installed !== null);
    results.push({ dir, status: "written" });
  }
  return results;
}
