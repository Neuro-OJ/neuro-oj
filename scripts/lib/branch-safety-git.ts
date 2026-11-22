/**
 * 分支安全自检 · git 层。
 *
 * 只负责跟 git 交互并把输出解析成结构：目标分支解析、分叉点、本分支改动、
 * 目标分支在分叉后碰过哪些文件、本分支的净删除行数、提交签名与提交信息。
 * 判定规则在 `branch-safety-checks.ts`。
 *
 * 性能约定：**每个检查项最多一次 git 子进程**。逐文件跑 `git log` 在几千文件
 * 时是 O(文件数) 次进程启动（Windows 上每次几十毫秒），这里统一成"一次
 * `git log --name-only` 扫完再按文件归并"。
 */

/** git 命令输出。 */
export interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** 默认目标分支。 */
export const DEFAULT_BASE = "origin/main";

/** 目标分支取不到时的退路（本地常没有 origin/main）。 */
const BASE_FALLBACKS: readonly string[] = ["origin/main", "main"];

/** 分支改动文件的 git 状态（`--no-renames` 下只有 A/M/D/T）。 */
export interface ChangedFile {
  path: string;
  status: string;
}

/** 目标分支上的一个提交。 */
export interface CommitTouch {
  sha: string;
  subject: string;
}

/** 一段提交（签名与提交信息共用一次 git log 的输出）。 */
export interface BranchCommit {
  sha: string;
  /** 父提交数量：≥2 即合并提交。 */
  parents: number;
  /** `%G?` 的原始取值：G 有效、N 无签名、B 签名无效…… */
  signature: string;
  subject: string;
}

/** 执行 git 命令（argv 数组，不经 shell）。 */
export async function runGit(
  root: string,
  args: string[],
  allowFailure = false,
): Promise<GitOutput> {
  const command = new Deno.Command("git", {
    args: ["-C", root, "-c", "core.quotepath=false", ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (output.code !== 0 && !allowFailure) {
    throw new Error(
      `git ${args.join(" ")} 失败：${stderr.trim() || `退出码 ${output.code}`}`,
    );
  }
  return { code: output.code, stdout, stderr };
}

/**
 * 解析目标分支：`requested` 为 null 时按 `origin/main` → `main` 依次尝试。
 *
 * 显式指定的分支解析不到时**不再回退**：用户已经指明 base，静默换一个分支会让
 * 「A 检查没报」变成假绿。
 */
export async function resolveBaseRef(
  root: string,
  requested: string | null,
): Promise<{ ref: string; commit: string }> {
  const candidates = requested === null ? BASE_FALLBACKS : [requested];
  for (const candidate of candidates) {
    const result = await runGit(
      root,
      ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
      true,
    );
    if (result.code === 0) {
      return { ref: candidate, commit: result.stdout.trim() };
    }
  }
  throw new Error(
    requested === null
      ? `无法解析目标分支（已尝试 ${
        candidates.join(" / ")
      }）：先 git fetch，或用 --base 指定`
      : `无法解析目标分支 ${requested}：先 git fetch，或用 --base 指定`,
  );
}

/** 读取分叉点（目标分支与待检查提交的共同祖先）。 */
export async function readMergeBase(
  root: string,
  baseCommit: string,
  head = "HEAD",
): Promise<string> {
  const result = await runGit(root, ["merge-base", baseCommit, head], true);
  const mergeBase = result.stdout.trim();
  if (result.code !== 0 || mergeBase === "") {
    throw new Error(
      `找不到 ${baseCommit} 与 ${head} 的共同祖先：目标分支与该提交没有共同历史`,
    );
  }
  return mergeBase;
}

/** 把任意 revision 解析成完整提交 SHA；解析不到返回 null。 */
export async function resolveCommit(
  root: string,
  revision: string,
): Promise<string | null> {
  const result = await runGit(
    root,
    ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`],
    true,
  );
  return result.code === 0 ? result.stdout.trim() : null;
}

/** `ancestor` 是否是 `descendant` 的祖先（含相等）。 */
export async function isAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await runGit(
    root,
    ["merge-base", "--is-ancestor", ancestor, descendant],
    true,
  );
  return result.code === 0;
}

/** 本分支相对分叉点的 HEAD 短哈希与分支名。 */
export async function readHeadAndBranch(
  root: string,
): Promise<{ head: string; branch: string }> {
  const head = (await runGit(root, ["rev-parse", "--short", "HEAD"])).stdout
    .trim();
  const branch = (await runGit(root, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ])).stdout.trim();
  return { head, branch };
}

/**
 * 本分支相对分叉点改过的文件。
 *
 * 关掉重命名检测：重命名按「删 + 增」处理。重命名恰好也是"目标分支改过它"
 * 的高危场景——旧路径上的目标分支改动会随重命名一起消失。
 */
export async function collectChangedFiles(
  root: string,
  from: string,
  to = "HEAD",
): Promise<ChangedFile[]> {
  const { stdout } = await runGit(root, [
    "diff",
    "--name-status",
    "--no-renames",
    `${from}..${to}`,
  ]);
  const files: ChangedFile[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    files.push({ status: line.slice(0, tab), path: line.slice(tab + 1) });
  }
  return files;
}

/**
 * 目标分支在分叉之后改过哪些文件（一次 `git log --name-only` 解析完）。
 *
 * `-m` 让合并提交也带上文件列表；同一合并提交按父提交会重复出现，用 sha 去重。
 * 只保留 `wanted` 里的文件，避免把目标分支的全部改动都读进内存。
 */
export async function collectBaseTouches(
  root: string,
  mergeBase: string,
  base: string,
  wanted: ReadonlySet<string>,
): Promise<{ touches: Map<string, CommitTouch[]>; commitCount: number }> {
  const { stdout } = await runGit(root, [
    "log",
    "--format=%h%x09%s",
    "--name-only",
    "-m",
    `${mergeBase}..${base}`,
  ]);
  const touches = new Map<string, CommitTouch[]>();
  const seenCommits = new Set<string>();
  let current: CommitTouch | null = null;

  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const header = line.match(/^([0-9a-f]{7,40})\t(.*)$/);
    if (header !== null) {
      current = { sha: header[1], subject: header[2] };
      seenCommits.add(current.sha);
      continue;
    }
    if (current === null || !wanted.has(line)) continue;
    const list = touches.get(line) ?? [];
    if (!list.some((item) => item.sha === current!.sha)) list.push(current);
    touches.set(line, list);
  }

  return { touches, commitCount: seenCommits.size };
}

/** 本分支相对分叉点的净删除行数（`-w` 忽略纯空白改动；null = 二进制）。 */
export async function collectDeletedLines(
  root: string,
  from: string,
  to = "HEAD",
): Promise<Map<string, number | null>> {
  const { stdout } = await runGit(root, [
    "diff",
    "--numstat",
    "-w",
    "--no-renames",
    `${from}..${to}`,
  ]);
  const deleted = new Map<string, number | null>();
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const count = Number(parts[1]);
    deleted.set(parts.slice(2).join("\t"), Number.isNaN(count) ? null : count);
  }
  return deleted;
}

/** 读取一段提交（签名与提交信息共用一次 git log 的输出）。 */
export async function collectCommits(
  root: string,
  revisions: readonly string[],
): Promise<BranchCommit[]> {
  const { stdout } = await runGit(root, [
    "log",
    "--format=%h%x09%P%x09%G?%x09%s",
    ...revisions,
  ]);
  const commits: BranchCommit[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const parents = parts[1].trim();
    commits.push({
      sha: parts[0],
      parents: parents === "" ? 0 : parents.split(" ").length,
      signature: parts[2],
      subject: parts.slice(3).join("\t"),
    });
  }
  return commits;
}

/** 本分支相对分叉点的提交（签名与提交信息共用一次 git log 的输出）。 */
export function collectBranchCommits(
  root: string,
  mergeBase: string,
  head = "HEAD",
): Promise<BranchCommit[]> {
  return collectCommits(root, [`${mergeBase}..${head}`]);
}
