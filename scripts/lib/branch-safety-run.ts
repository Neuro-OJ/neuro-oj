/**
 * 分支安全自检 · 一次分析的装配。
 *
 * `runChecks` 检查当前 HEAD；`analyzeTarget` 是两者共用的核心：给定「待检查提交 +
 * 分叉点 + 待推送提交范围」，跑 A/B/C/D 并汇总。内容与存在性一律从 `head` 的提交树取。
 */

import {
  checkCommitMessages,
  checkOverwrites,
  checkReferences,
  checkSignatures,
  type Finding,
  INFO_DELETED_MAX,
  ZERO_REFERENCE_FILE_THRESHOLD,
} from "./branch-safety-checks.ts";
import type { BranchCommit, ChangedFile } from "./branch-safety-git.ts";
import {
  collectBranchCommits,
  collectChangedFiles,
  readHeadAndBranch,
  readMergeBase,
  resolveBaseRef,
  resolveCommit,
  runGit,
} from "./branch-safety-git.ts";
import { openTreeSource } from "./branch-safety-tree.ts";

export type { CheckId, Finding, Level } from "./branch-safety-checks.ts";
export { DEFAULT_BASE } from "./branch-safety-git.ts";

/** 一次运行的完整结果（`--json` 直接序列化它）。 */
export interface RunResult {
  ok: boolean;
  base: string;
  base_commit: string;
  merge_base: string;
  head: string;
  branch: string;
  findings: Finding[];
  summary: { error: number; warn: number; info: number };
  stats: {
    branch_files: number;
    reference_files: number;
    reference_count: number;
    base_commits: number;
  };
  skipped: { signatures: boolean; merge_commits: number };
}

/** 一次分析（不含 base/分支标签）。pushed-refs 模式按引用复用。 */
export interface TargetAnalysis {
  findings: Finding[];
  summary: RunResult["summary"];
  stats: RunResult["stats"];
  skipped: RunResult["skipped"];
}

/**
 * 检查一个提交：A 用「分叉点..head」的改动文件，B 读 head 的提交树，
 * C/D 用传入的提交范围（pre-push 只检查本次待推送的提交）。
 */
export async function analyzeTarget(options: {
  root: string;
  baseLabel: string;
  baseCommit: string;
  headCommit: string;
  mergeBase: string;
  changedFiles: readonly ChangedFile[];
  commits: readonly BranchCommit[];
  ignoreSignatures: boolean;
  infoDeletedMax?: number;
}): Promise<TargetAnalysis> {
  const tree = await openTreeSource(options.root, options.headCommit);
  try {
    const overwrites = await checkOverwrites(
      options.root,
      options.mergeBase,
      options.baseCommit,
      options.baseLabel,
      options.changedFiles,
      options.infoDeletedMax ?? INFO_DELETED_MAX,
      options.headCommit,
    );
    // 内容与存在性都从待检查提交的树取，不读工作区。
    const references = await checkReferences(tree, options.changedFiles);
    const signatureFindings = checkSignatures(
      options.commits,
      options.ignoreSignatures,
    );
    const messageCheck = checkCommitMessages(options.commits);

    const findings: Finding[] = [
      ...overwrites.findings,
      ...references.findings,
      ...signatureFindings,
      ...messageCheck.findings,
    ];

    // 扫描规则失效守卫：读到足够多的文件却一个引用都没识别到，说明解析器坏了，
    // 而不是"仓库里真的没有引用"。
    if (
      references.files.length >= ZERO_REFERENCE_FILE_THRESHOLD &&
      references.count === 0
    ) {
      findings.push({
        check: "B",
        level: "warn",
        message:
          `引用扫描读取了 ${references.files.length} 个文件却一个引用都没识别到——扫描规则可能已失效`,
      });
    }

    const summary = { error: 0, warn: 0, info: 0 };
    for (const finding of findings) summary[finding.level]++;

    return {
      findings,
      summary,
      stats: {
        branch_files: options.changedFiles.length,
        reference_files: references.files.length,
        reference_count: references.count,
        base_commits: overwrites.baseCommits,
      },
      skipped: {
        signatures: options.ignoreSignatures,
        merge_commits: messageCheck.mergeCommits,
      },
    };
  } finally {
    await tree.close();
  }
}

/** 运行全部检查。抛出异常表示"无法运行"（不是"检查不通过"）。 */
export async function runChecks(
  options: {
    root?: string;
    base?: string | null;
    ignoreSignatures?: boolean;
    infoDeletedMax?: number;
  } = {},
): Promise<RunResult> {
  const cwd = options.root ?? Deno.cwd();
  const toplevel = await runGit(cwd, ["rev-parse", "--show-toplevel"], true);
  const root = toplevel.code === 0 ? toplevel.stdout.trim() : "";
  if (root === "") throw new Error(`不是 git 仓库：${cwd}`);

  const base = await resolveBaseRef(root, options.base ?? null);
  const headCommit = await resolveCommit(root, "HEAD");
  if (headCommit === null) throw new Error("无法解析 HEAD 指向的提交");
  const mergeBase = await readMergeBase(root, base.commit, headCommit);
  const { head, branch } = await readHeadAndBranch(root);
  const baseLabel = base.ref.split("/").pop() ?? base.ref;

  const changedFiles = await collectChangedFiles(root, mergeBase, headCommit);
  const commits = await collectBranchCommits(root, mergeBase, headCommit);
  const analysis = await analyzeTarget({
    root,
    baseLabel,
    baseCommit: base.commit,
    headCommit,
    mergeBase,
    changedFiles,
    commits,
    ignoreSignatures: options.ignoreSignatures ?? false,
    infoDeletedMax: options.infoDeletedMax,
  });

  return {
    ok: analysis.summary.error === 0,
    base: base.ref,
    base_commit: base.commit,
    merge_base: mergeBase,
    head,
    branch,
    ...analysis,
  };
}
