/**
 * 分支安全自检 · 四个检查项的判定规则。
 *
 * 这里只产出 `Finding`，不打印、不退出——报告与退出码由入口脚本决定，
 * 方便单测直接断言规则本身。
 */

import { checkBrokenReferences } from "./branch-safety-references.ts";
import type {
  BranchCommit,
  ChangedFile,
  CommitTouch,
} from "./branch-safety-git.ts";
import {
  collectBaseTouches,
  collectDeletedLines,
} from "./branch-safety-git.ts";
import type { TreeSource } from "./branch-safety-tree.ts";

/** 检查项标识（与输出章节一一对应）。 */
export type CheckId = "A" | "B" | "C" | "D";

/** 严重级别：error 阻断退出码，warn/info 只打印。 */
export type Level = "error" | "warn" | "info";

/** 一条检查结果。 */
export interface Finding {
  check: CheckId;
  level: Level;
  /** 人类可读的一句话。 */
  message: string;
  /** 相关文件（相对仓库根）。 */
  path?: string;
  /** 相关行号（1 起始）。 */
  line?: number;
  /** 相关提交短哈希（C/D 检查用）。 */
  sha?: string;
  /** 相关提交（A 检查用）。 */
  commits?: CommitTouch[];
  /** 补充说明（缩进输出在 message 下一行）。 */
  detail?: string;
}

/** 提交信息 type 白名单。 */
export const COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "chore",
  "ci",
  "build",
] as const;

/** 提交信息 scope 白名单（多 scope 用英文逗号分隔、不加空格）。 */
export const ALLOWED_SCOPES = [
  "core",
  "ui",
  "judge",
  "gateway",
  "cli",
  "lmcc",
  "docs",
  "tests",
  "root",
  "ci",
  "deps",
] as const;

/** 分支侧净删除行数不超过该值时，A 检查降为 info（疑似仅重命名/路径替换）。 */
export const INFO_DELETED_MAX = 3;

const WITH_SCOPE = new RegExp(`^(${COMMIT_TYPES.join("|")})\\(([^)]*)\\): .+`);
const WITHOUT_SCOPE = new RegExp(`^(${COMMIT_TYPES.join("|")}): .+`);

/** 引用扫描的两个根：跨模块测试与仓库脚本最容易漏改。 */
const REFERENCE_ROOTS = ["noj-tests", "scripts"];

/** 引用扫描只读这两类文件。 */
const REFERENCE_EXTENSIONS = [".ts", ".vue"];

/** 引用扫描跳过的目录（缓存与构建产物会拖慢启动）。 */
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".nuxt",
  ".output",
  "dist",
  "target",
  "coverage",
  ".test-cache",
  ".test-storage",
]);

/**
 * 零引用守卫的触发下限：扫描文件数达到该值却一个引用都没识别到时，判定扫描规则失效。
 *
 * 下限是为了让单测的极小夹具不触发（真实仓库有 170+ 个文件、300+ 处引用）。
 */
export const ZERO_REFERENCE_FILE_THRESHOLD = 20;

const SIGNATURE_HINTS: Record<string, string> = {
  N: "没有签名",
  B: "签名无效",
  U: "密钥不可信",
  X: "签名已过期",
  Y: "密钥已过期",
  R: "密钥已撤销",
  E: "无法验证（缺少公钥）",
  G: "签名有效",
  "?": "未知结果",
};

/** 校验一条提交信息；返回 null 表示合规。 */
export function validateCommitMessage(
  subject: string,
): { level: Level; reason: string } | null {
  const matched = subject.match(WITH_SCOPE);
  if (matched !== null) {
    const scopeText = matched[2];
    const scopes = scopeText.split(",");
    const invalid = scopes.filter((scope) =>
      !(ALLOWED_SCOPES as readonly string[]).includes(scope)
    );
    if (invalid.length === 0) return null;
    if (invalid.some((scope) => scope.trim() === "")) {
      return {
        level: "warn",
        reason:
          `scope 不能为空、不能带空格、也不能有多余逗号：${scopeText}（多 scope 用英文逗号分隔）`,
      };
    }
    return {
      level: "warn",
      reason: `scope 不在白名单：${invalid.join(",")}（允许 ${
        ALLOWED_SCOPES.join("/")
      }）`,
    };
  }
  if (WITHOUT_SCOPE.test(subject)) {
    return {
      level: "error",
      reason:
        `提交信息缺少 scope——必须写成 <type>(<scope>): <描述>，scope 只能是 ${
          ALLOWED_SCOPES.join("/")
        }`,
    };
  }
  return {
    level: "warn",
    reason:
      "提交信息不符合 <type>(<scope>): <描述>（type 取 feat/fix/docs 等）",
  };
}

/**
 * 检查项 A：静默覆盖。
 *
 * 唯一会真正丢逻辑的一项：目标分支在分叉后改过、本分支也改过的文件，
 * 只要本分支侧删掉了既有行，目标分支的改动就可能被整段覆盖。
 */
export async function checkOverwrites(
  root: string,
  mergeBase: string,
  base: string,
  baseLabel: string,
  changedFiles: readonly ChangedFile[],
  infoDeletedMax: number,
  head: string,
): Promise<{ findings: Finding[]; baseCommits: number }> {
  // 删除也算"改了"：目标分支改过的文件被本分支删掉（重命名在 `--no-renames`
  // 下正是"删 + 增"）同样是静默丢失，不能跳过。
  const live = [...changedFiles];
  const wanted = new Set(live.map((file) => file.path));
  const { touches, commitCount } = await collectBaseTouches(
    root,
    mergeBase,
    base,
    wanted,
  );
  if (touches.size === 0) return { findings: [], baseCommits: commitCount };

  const deletedLines = await collectDeletedLines(root, mergeBase, head);
  const findings: Finding[] = [];
  for (const file of live) {
    const commits = touches.get(file.path);
    if (commits === undefined) continue;
    const deleted = deletedLines.get(file.path) ?? 0;
    const level: Level = deleted !== null && deleted <= infoDeletedMax
      ? "info"
      : "warn";
    const commitText = commits.length === 1
      ? `${baseLabel} 侧 ${commits[0].sha} ${commits[0].subject}`
      : `${baseLabel} 侧 ${commits.length} 个提交：${
        commits.map((commit) => `${commit.sha} ${commit.subject}`).join("；")
      }`;
    const detail = file.status === "D"
      ? `该文件在本分支已删除（重命名也表现为删除），请确认 ${baseLabel} 的改动已经带到新位置，而不是随删除一起消失`
      : level === "warn"
      ? `${baseLabel} 的改动可能被整段覆盖，请逐行确认没有被覆盖`
      : deleted === 0
      ? "本分支侧只新增行、没有删除既有行，疑似仅新增/重命名，请确认"
      : `本分支侧仅净删除 ${deleted} 行（≤${infoDeletedMax}），疑似仅重命名/路径替换，请确认`;
    findings.push({
      check: "A",
      level,
      path: file.path,
      message: `目标分支在分叉后改过它，本分支也改了：${commitText}`,
      detail,
      commits,
    });
  }
  return { findings, baseCommits: commitCount };
}

/** 检查项 C：提交签名（只有 `%G?=G` 才算通过）。 */
export function checkSignatures(
  commits: readonly BranchCommit[],
  ignored: boolean,
): Finding[] {
  if (ignored) return [];
  const findings: Finding[] = [];
  for (const commit of commits) {
    if (commit.signature === "G") continue;
    const hint = SIGNATURE_HINTS[commit.signature] ?? "未知结果";
    findings.push({
      check: "C",
      level: "error",
      sha: commit.sha,
      message: `未通过 GPG 签名验证（%G?=${commit.signature}：${hint}）`,
      detail:
        `提交信息：${commit.subject}\n签名修复：git commit --amend -S；本地无 GPG 时可加 --ignore-signatures 跳过`,
    });
  }
  return findings;
}

/** 检查项 D：提交信息（合并提交由 git 生成，跳过）。 */
export function checkCommitMessages(
  commits: readonly BranchCommit[],
): { findings: Finding[]; mergeCommits: number } {
  const findings: Finding[] = [];
  let mergeCommits = 0;
  for (const commit of commits) {
    if (commit.parents >= 2) {
      mergeCommits++;
      continue;
    }
    const verdict = validateCommitMessage(commit.subject);
    if (verdict === null) continue;
    findings.push({
      check: "D",
      level: verdict.level,
      sha: commit.sha,
      message: verdict.reason,
      detail: `实际提交信息：${commit.subject}`,
    });
  }
  return { findings, mergeCommits };
}

/** 收集引用扫描范围内的文件：改动文件 + 全仓 noj-tests/、scripts/ 下的源码。 */
async function collectReferenceFiles(
  tree: TreeSource,
  changedFiles: readonly ChangedFile[],
): Promise<string[]> {
  const files = new Set<string>();
  const tracked = await tree.listFiles();
  const trackedSet = new Set(tracked);

  for (const file of changedFiles) {
    // 以提交树为准：重命名/删除后的旧路径不在树里，不扫描。
    if (!trackedSet.has(file.path)) continue;
    if (
      REFERENCE_EXTENSIONS.some((extension) => file.path.endsWith(extension))
    ) {
      files.add(file.path);
    }
  }

  for (const path of tracked) {
    if (!REFERENCE_ROOTS.some((root) => path.startsWith(`${root}/`))) continue;
    if (
      !REFERENCE_EXTENSIONS.some((extension) => path.endsWith(extension))
    ) {
      continue;
    }
    const directories = path.split("/").slice(0, -1);
    if (
      directories.some((segment) =>
        SKIPPED_DIRS.has(segment) || segment.startsWith(".")
      )
    ) {
      continue;
    }
    files.add(path);
  }
  return [...files].sort();
}

/** 检查项 B：断链引用（本分支改过的文件 + 全仓 noj-tests/、scripts/）。 */
export async function checkReferences(
  tree: TreeSource,
  changedFiles: readonly ChangedFile[],
): Promise<{ findings: Finding[]; files: string[]; count: number }> {
  const files = await collectReferenceFiles(tree, changedFiles);
  const { broken, stats } = await checkBrokenReferences({ tree, files });
  const findings: Finding[] = broken.map((item) => {
    const fromString = item.kind === "string";
    return {
      check: "B",
      // 字符串字面量的基准目录有歧义（仓库根 / 模块根 / 运行时 cwd），
      // 只作提示；导入断链是构建期硬失败，必须阻断。
      level: fromString ? "warn" : "error",
      path: item.file,
      line: item.line,
      message: fromString
        ? `字符串里的路径不存在: ${item.specifier}`
        : `引用了不存在的路径: ${item.specifier}`,
      detail: fromString
        ? `解析为 ${item.resolvedPath}（不存在）；可能是夹具/说明文字，请人工确认`
        : item.resolvedPath === item.specifier
        ? undefined
        : `解析为 ${item.resolvedPath}（不存在）`,
    };
  });
  return { findings, files, count: stats.references };
}
