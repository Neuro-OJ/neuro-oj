/**
 * 分支安全自检 · pre-push 待推送引用。
 *
 * git 在 pre-push 钩子的 stdin 上逐行给出
 * `<local-ref> <local-sha> <remote-ref> <remote-sha>`（`remote-sha` 全 0 = 新分支）。
 * 这里按每个引用分别确定「待推送的提交范围」：
 * - 已存在的远端分支：`remote-sha..local-sha`；
 * - 新分支：`local-sha --not --remotes`（本地全部远端跟踪引用都不包含的提交）。
 *
 * 检查对象（文件内容 / 存在性）取 `local-sha` 的提交树，与当前检出分支和工作区无关；
 * 多个引用汇总，任一引用有 error 即整体失败。
 */

import type { Finding } from "./branch-safety-checks.ts";
import type { RunResult, TargetAnalysis } from "./branch-safety-run.ts";
import { analyzeTarget } from "./branch-safety-run.ts";
import {
  collectChangedFiles,
  collectCommits,
  isAncestor,
  readMergeBase,
  resolveBaseRef,
  resolveCommit,
  runGit,
} from "./branch-safety-git.ts";

/** 一行 pre-push 输入。 */
export interface PushedRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

/** 一个待推送引用的检查结果。 */
export interface RefRunResult {
  ok: boolean;
  local_ref: string;
  remote_ref: string;
  /** 待检查提交（短 SHA，仅供展示）。 */
  head: string;
  head_commit: string;
  remote_commit: string;
  base: string;
  merge_base: string;
  /** 本次待推送的提交数。 */
  pushed_commits: number;
  findings: Finding[];
  summary: RunResult["summary"];
  stats: RunResult["stats"];
  skipped: RunResult["skipped"];
  /** 跳过检查的原因（删除引用 / 已合并 / 无法解析远端提交等）。 */
  note?: string;
  /** 该引用无法完成检查（解析失败等）。 */
  error?: string;
}

/** 一次 pre-push 自检的汇总结果。 */
export interface PushedRunResult {
  ok: boolean;
  base: string;
  base_commit: string;
  refs: RefRunResult[];
  summary: RunResult["summary"];
}

/** 零对象 ID（SHA-1 40 位 / SHA-256 64 位，全 0）。 */
export function isZeroSha(value: string): boolean {
  return /^0{40,64}$/.test(value);
}

/**
 * 解析 pre-push stdin。
 *
 * 空行忽略（git 末尾会补换行）；字段数不为 4 或 SHA 明显非法时抛错——说明输入
 * 不是 git 的 pre-push 格式，继续猜只会检查错东西。
 */
export function parsePushedRefs(text: string): PushedRef[] {
  const refs: PushedRef[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "") continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 4) {
      throw new Error(
        `pre-push 输入第 ${
          index + 1
        } 行不是 4 个字段（local-ref local-sha remote-ref remote-sha）：${line}`,
      );
    }
    const [localRef, localSha, remoteRef, remoteSha] = parts;
    if (
      !/^[0-9a-f]{40,64}$/.test(localSha) ||
      !/^[0-9a-f]{40,64}$/.test(remoteSha)
    ) {
      throw new Error(
        `pre-push 输入第 ${
          index + 1
        } 行的对象 ID 不是 40/64 位十六进制：${line}`,
      );
    }
    refs.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return refs;
}

function emptySummary(): RunResult["summary"] {
  return { error: 0, warn: 0, info: 0 };
}

function emptyRefResult(
  ref: PushedRef,
  base: { ref: string; commit: string },
): RefRunResult {
  return {
    ok: true,
    local_ref: ref.localRef,
    remote_ref: ref.remoteRef,
    head: "",
    head_commit: "",
    remote_commit: ref.remoteSha,
    base: base.ref,
    merge_base: "",
    pushed_commits: 0,
    findings: [],
    summary: emptySummary(),
    stats: {
      branch_files: 0,
      reference_files: 0,
      reference_count: 0,
      base_commits: 0,
    },
    skipped: { signatures: false, merge_commits: 0 },
  };
}

function summarizeRef(
  result: RefRunResult,
  analysis: TargetAnalysis,
): RefRunResult {
  return {
    ...result,
    findings: analysis.findings,
    summary: analysis.summary,
    stats: analysis.stats,
    skipped: analysis.skipped,
    ok: analysis.summary.error === 0,
  };
}

/** 检查一个待推送引用。 */
async function checkPushedRef(
  root: string,
  base: { ref: string; commit: string },
  ref: PushedRef,
  options: { ignoreSignatures: boolean; infoDeletedMax?: number },
): Promise<RefRunResult> {
  const result = emptyRefResult(ref, base);

  if (ref.localRef === "(delete)" || isZeroSha(ref.localSha)) {
    return { ...result, note: "删除引用，无需检查" };
  }

  const headCommit = await resolveCommit(root, ref.localSha);
  if (headCommit === null) {
    return {
      ...result,
      ok: false,
      error: `无法解析待推送提交 ${ref.localSha}`,
    };
  }
  result.head = headCommit.slice(0, 7);
  result.head_commit = headCommit;

  if (await isAncestor(root, headCommit, base.commit)) {
    return {
      ...result,
      note: `已包含在 ${base.ref} 中，无需检查`,
    };
  }

  try {
    const mergeBase = await readMergeBase(root, base.commit, headCommit);
    result.merge_base = mergeBase;
    const changedFiles = await collectChangedFiles(
      root,
      mergeBase,
      headCommit,
    );

    let note: string | undefined;
    let revisions: string[];
    if (isZeroSha(ref.remoteSha)) {
      // 新分支：远端没有任何对应对象，用"本地全部远端跟踪引用都不包含"求新增提交。
      revisions = [headCommit, "--not", "--remotes"];
    } else if (await resolveCommit(root, ref.remoteSha) === null) {
      // 远端提交不在本地（没 fetch 到）：退化为按新增提交检查，避免误把远端已有
      // 的老提交重查一遍；放行比卡住推送更合理。
      revisions = [headCommit, "--not", "--remotes"];
      note =
        `远端提交 ${ref.remoteSha} 不在本地，按远端跟踪引用之外的新增提交检查`;
    } else {
      revisions = [`${ref.remoteSha}..${headCommit}`];
    }

    const commits = await collectCommits(root, revisions);
    const analysis = await analyzeTarget({
      root,
      baseLabel: base.ref.split("/").pop() ?? base.ref,
      baseCommit: base.commit,
      headCommit,
      mergeBase,
      changedFiles,
      commits,
      ignoreSignatures: options.ignoreSignatures,
      infoDeletedMax: options.infoDeletedMax,
    });
    return {
      ...summarizeRef(result, analysis),
      pushed_commits: commits.length,
      ...(note === undefined ? {} : { note }),
    };
  } catch (error) {
    return {
      ...result,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 检查所有待推送引用并汇总。
 *
 * 不读 stdin：调用方（CLI）负责把 `--pushed-refs -` 读成字符串再传进来，便于单测。
 */
export async function runPushedRefsChecks(
  options: {
    root?: string;
    base?: string | null;
    refsText?: string;
    refs?: readonly PushedRef[];
    ignoreSignatures?: boolean;
    infoDeletedMax?: number;
  } = {},
): Promise<PushedRunResult> {
  const cwd = options.root ?? Deno.cwd();
  const toplevel = await runGit(cwd, ["rev-parse", "--show-toplevel"], true);
  const root = toplevel.code === 0 ? toplevel.stdout.trim() : "";
  if (root === "") throw new Error(`不是 git 仓库：${cwd}`);

  const base = await resolveBaseRef(root, options.base ?? null);
  const refs = options.refs ?? parsePushedRefs(options.refsText ?? "");
  const ignoreSignatures = options.ignoreSignatures ?? false;

  const results: RefRunResult[] = [];
  for (const ref of refs) {
    results.push(
      await checkPushedRef(root, base, ref, {
        ignoreSignatures,
        infoDeletedMax: options.infoDeletedMax,
      }),
    );
  }

  const summary = emptySummary();
  for (const result of results) {
    summary.error += result.summary.error;
    summary.warn += result.summary.warn;
    summary.info += result.summary.info;
  }

  return {
    ok: results.every((result) => result.ok),
    base: base.ref,
    base_commit: base.commit,
    refs: results,
    summary,
  };
}
