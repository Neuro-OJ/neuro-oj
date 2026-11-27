/**
 * 分支安全自检（提交 / 推送前）。
 *
 * 为什么需要：下面三类问题本地测试全绿，只有真 CI 或人工复审才能发现——
 * 1. UI 目录按领域重组后，E2E 里的相对引用仍指向旧扁平路径，CI 的
 *    E2E Browser 三个分片全挂（TS2307）；
 * 2. 同一个 PR 修好后又断了一次同样的引用；
 * 3. 旧提交 cherry-pick 到新 main 时整段重写了中间件文件，静默覆盖掉 main
 *    后来加的大小写归一化与 destination.query 合并，直到复审才发现。
 *
 * 四个检查项（规则在 `scripts/lib/branch-safety-checks.ts`）：
 * A 静默覆盖：目标分支在分叉后改过、本分支也改过；
 * B 断链引用：相对/别名导入与仓库内路径字面量解析到不存在的文件；
 * C 提交签名：分叉后的提交必须 GPG 有效（`--ignore-signatures` 可跳过）；
 * D 提交信息：`<type>(<scope>): <描述>` 与 scope 白名单。
 *
 * 检查对象始终是**提交树**，不读工作区：未提交改动不参与判定，工作区停在别的
 * 分支也不影响结果。
 *
 * 退出码：有 error → 1；只有 warn / info → 0（但都会打印）。
 *
 * 用法：
 *   deno run -A scripts/check-branch-safety.ts [--base origin/main] [--json]
 *   deno run -A scripts/check-branch-safety.ts --pushed-refs - < pre-push-stdin
 */

import { DEFAULT_BASE } from "./lib/branch-safety-git.ts";
import { runPushedRefsChecks } from "./lib/branch-safety-pushed.ts";
import { renderPushedText, renderText } from "./lib/branch-safety-report.ts";
import { runChecks } from "./lib/branch-safety-run.ts";

export type { CheckId, Finding, Level } from "./lib/branch-safety-checks.ts";
export type {
  PushedRunResult,
  RefRunResult,
} from "./lib/branch-safety-pushed.ts";
export type { RunResult } from "./lib/branch-safety-run.ts";
export { runChecks } from "./lib/branch-safety-run.ts";

const USAGE =
  `分支安全自检：推送前检查「静默覆盖 / 断链引用 / 提交签名 / 提交信息」。

用法：
  deno run -A scripts/check-branch-safety.ts [选项]
  deno run -A scripts/check-branch-safety.ts --pushed-refs - < pre-push 输入

选项：
  --base <ref>         目标分支（默认 ${DEFAULT_BASE}，取不到时退回 main）
  --pushed-refs <文件> 按 pre-push 引用逐条检查待推送范围；\`-\` 表示读 stdin
  --json               输出结构化结果（JSON），供其他工具消费
  --ignore-signatures  跳过 GPG 签名检查（本地没有 GPG 的环境）
  -h, --help           显示本帮助

退出码：任何 error → 1；只有 warn / info → 0（仍然会打印）。`;

/** 命令行选项。 */
export interface CliOptions {
  base: string | null;
  pushedRefs: string | null;
  json: boolean;
  ignoreSignatures: boolean;
  help: boolean;
}

/** 解析 `Deno.args`（支持 `--flag` 与 `--flag value` / `--flag=value`）。 */
export function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    base: null,
    pushedRefs: null,
    json: false,
    ignoreSignatures: false,
    help: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--ignore-signatures") {
      options.ignoreSignatures = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--base") {
      const value = args[++index];
      if (value === undefined) throw new Error("--base 需要一个分支名或提交");
      options.base = value;
      continue;
    }
    if (arg.startsWith("--base=")) {
      options.base = arg.slice("--base=".length);
      continue;
    }
    if (arg === "--pushed-refs") {
      const value = args[++index];
      if (value === undefined) {
        throw new Error("--pushed-refs 需要一个文件或 -");
      }
      options.pushedRefs = value;
      continue;
    }
    if (arg.startsWith("--pushed-refs=")) {
      options.pushedRefs = arg.slice("--pushed-refs=".length);
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  return options;
}

/** 读取 pre-push 输入：`-` 读 stdin，其余按文件路径。 */
async function readPushedRefsInput(source: string): Promise<string> {
  if (source === "-") return await new Response(Deno.stdin.readable).text();
  return await Deno.readTextFile(source);
}

if (import.meta.main) {
  let options: CliOptions;
  try {
    options = parseArgs(Deno.args);
  } catch (error) {
    console.error(
      `参数错误：${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(USAGE);
    Deno.exit(1);
  }

  if (options.help) {
    console.log(USAGE);
    Deno.exit(0);
  }

  try {
    if (options.pushedRefs !== null) {
      const result = await runPushedRefsChecks({
        base: options.base,
        refsText: await readPushedRefsInput(options.pushedRefs),
        ignoreSignatures: options.ignoreSignatures,
      });
      console.log(
        options.json
          ? JSON.stringify(result, null, 2)
          : renderPushedText(result),
      );
      Deno.exit(result.ok ? 0 : 1);
    }

    const result = await runChecks({
      base: options.base,
      ignoreSignatures: options.ignoreSignatures,
    });
    console.log(
      options.json ? JSON.stringify(result, null, 2) : renderText(result),
    );
    Deno.exit(result.ok ? 0 : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`分支安全自检无法运行：${message}`);
    }
    Deno.exit(1);
  }
}
