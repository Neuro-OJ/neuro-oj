/**
 * `noj-cli problem test [dir]`：本地 Docker 沙箱验题（P0-2 A）。
 *
 * 流程：lint（失败即停）→ 规范化 manifest → 构建支持包 → 逐个参考解答经
 * `noj-judge run-local` 评测 → 对照断言。退出码：0 通过 / 1 校验或断言失败 /
 * 2 用法错误（含找不到 noj-judge）。设计见 `dev-docs/design/problem-local-test.md`。
 */
import { join, resolve } from "@std/path";
import { EXIT_FAILURE, EXIT_OK } from "../cli-commands/exit-codes.ts";
import { UsageError } from "../util/args.ts";
import { lintBundle } from "./lint.ts";
import {
  type ProblemBundleManifest,
  validateBundleManifest,
} from "../../../noj-core/src/modules/problems/types/problem-bundle.ts";
import {
  buildSupportPackage,
  checkExpectation,
  DEFAULT_EXPECT_FILE,
  DEFAULT_SUBMISSIONS_DIR,
  discoverSolutions,
  type Expectation,
  JudgeUnavailableError,
  type LlmMode,
  type LocalRunOptions,
  parseExpectation,
  parseExpectFile,
  parseSolutionArg,
  probeJudge,
  resolveJudgeBin,
  runSolution,
  type SolutionReport,
  type SolutionSpec,
} from "./judge-local.ts";
import type { ProblemArgs } from "./command.ts";
import { formatLintReport, readBundleFiles } from "./command.ts";

/** 单条断言的判定结果。 */
export interface ExpectationResult {
  expect: string;
  name: string;
  actual: number | null;
  pass: boolean;
}

/** 断言判定（纯函数，便于单测）：解答失败（error）一律视为不满足。 */
export function evaluateExpectations(
  reports: SolutionReport[],
  expectations: Expectation[],
): ExpectationResult[] {
  return expectations.map((e) => {
    const report = reports.find((r) => r.name === e.name);
    const actual = report && report.error === null ? report.score : null;
    return {
      expect: e.raw,
      name: e.name,
      actual,
      pass: actual !== null && checkExpectation(actual, e),
    };
  });
}

/** 由参数推导 LLM 执行方式（参数组合非法属用法错误）。 */
export function resolveLlmMode(args: ProblemArgs): LlmMode {
  if (args.llmGateway !== undefined) {
    if (!args.allowNetwork) {
      throw new UsageError("--llm-gateway 需要同时指定 --allow-network");
    }
    if (!args.llmToken) {
      throw new UsageError("--llm-gateway 需要同时指定 --llm-token");
    }
    return { kind: "gateway", url: args.llmGateway, token: args.llmToken };
  }
  if (args.llmToken !== undefined) {
    throw new UsageError("--llm-token 需要配合 --llm-gateway");
  }
  return args.llmMock ? { kind: "mock" } : { kind: "none" };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function formatScore(score: number | null): string {
  return score === null ? "-" : score.toFixed(2);
}

function renderHuman(
  reports: SolutionReport[],
  results: ExpectationResult[],
  notes: string[],
): string {
  const lines: string[] = [];
  for (const note of notes) lines.push(`提示: ${note}`);
  lines.push("解答结果:");
  for (const r of reports) {
    const time = r.time_ms === null ? "" : ` time=${r.time_ms}ms`;
    lines.push(
      `  ${r.name.padEnd(12)} score=${
        formatScore(r.score).padStart(6)
      } status=${r.status}${time} wall=${r.wall_ms}ms`,
    );
    if (r.error) lines.push(`    错误: ${r.error}`);
    if (r.stderr) {
      lines.push("    stderr 摘要:");
      for (const l of r.stderr.split("\n")) lines.push(`      ${l}`);
    }
  }
  if (results.length > 0) {
    lines.push("断言:");
    for (const r of results) {
      lines.push(
        `  ${r.pass ? "✓" : "✗"} ${r.expect}（实际 ${formatScore(r.actual)}）`,
      );
    }
  }
  return lines.join("\n");
}

/** 执行 `problem test`。 */
export async function runProblemTest(args: ProblemArgs): Promise<number> {
  const dir = resolve(args.dir ?? Deno.cwd());
  try {
    if (!(await Deno.stat(dir)).isDirectory) throw new Error();
  } catch {
    throw new UsageError(`目录不存在或不是目录：${dir}`);
  }
  if (args.network !== undefined && !args.allowNetwork) {
    throw new UsageError("--network 需要同时指定 --allow-network");
  }
  const llmMode = resolveLlmMode(args);

  // 1. lint：失败即停（与 pack/push 一致）
  const lint = lintBundle(await readBundleFiles(dir));
  if (lint.hasError) {
    if (args.json) {
      console.log(JSON.stringify(
        { pass: false, stage: "lint", dir, findings: lint.findings },
        null,
        2,
      ));
    } else {
      console.error(formatLintReport(lint.findings));
      console.error("lint 未通过，已停止本地评测。");
    }
    return EXIT_FAILURE;
  }
  const manifest: ProblemBundleManifest = validateBundleManifest(
    JSON.parse(await Deno.readTextFile(join(dir, "problem.json"))),
  );

  // 2. 参考解答与断言
  const cwd = Deno.cwd();
  let solutions: SolutionSpec[];
  try {
    solutions = args.solutions.map((s) => parseSolutionArg(s, cwd));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const submissionsDir = join(dir, DEFAULT_SUBMISSIONS_DIR);
  if (solutions.length === 0 && await exists(submissionsDir)) {
    solutions = await discoverSolutions(submissionsDir);
  }
  if (solutions.length === 0) {
    throw new UsageError(
      `没有参考解答：请用 --solution 指定，或在 ${DEFAULT_SUBMISSIONS_DIR}/ 下放置解答`,
    );
  }
  const names = new Set<string>();
  for (const s of solutions) {
    if (names.has(s.name)) {
      throw new UsageError(
        `参考解答名称重复：${s.name}（可用 path@name 改名）`,
      );
    }
    if (!(await exists(s.path))) {
      throw new UsageError(`参考解答不存在：${s.path}`);
    }
    names.add(s.name);
  }

  let expectations: Expectation[];
  try {
    if (args.expects.length > 0) {
      expectations = args.expects.map(parseExpectation);
    } else {
      const expectFile = join(submissionsDir, DEFAULT_EXPECT_FILE);
      expectations = await exists(expectFile)
        ? parseExpectFile(await Deno.readTextFile(expectFile))
        : [];
    }
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  for (const e of expectations) {
    if (!names.has(e.name)) {
      throw new UsageError(
        `断言引用了不存在的解答：${e.name}（已有：${[...names].join(", ")}）`,
      );
    }
  }

  const notes: string[] = [];
  if (manifest.llm && llmMode.kind === "mock") {
    notes.push(
      "LLM 使用离线 mock（回显最后一条 user 消息），只验证调用链路与预算；" +
        "真实效果请用 --allow-network --llm-gateway <url> --llm-token <t>",
    );
  } else if (manifest.llm && llmMode.kind === "none") {
    notes.push("未注入 LLM 配置（--no-llm-mock），evaluator 调用 LLM 会失败");
  }

  // 3. 支持包与逐个运行
  const options: LocalRunOptions = {
    judgeBin: resolveJudgeBin(args.judgeBin),
    allowNetwork: args.allowNetwork,
    network: args.network,
    llm: llmMode,
  };
  const scratch = await Deno.makeTempDir({ prefix: "noj-problem-test-" });
  const reports: SolutionReport[] = [];
  try {
    let supportPath: string | null = null;
    if (manifest.kind !== "objective") {
      // 先确认 judge 支持 run-local，避免旧版二进制被当作 Worker 启动。
      try {
        await probeJudge(options.judgeBin);
      } catch (err) {
        if (err instanceof JudgeUnavailableError) {
          throw new UsageError(err.message);
        }
        throw err;
      }
      supportPath = join(scratch, "support.zip");
      await Deno.writeFile(supportPath, await buildSupportPackage(dir));
    }
    for (const solution of solutions) {
      if (!args.json) console.error(`运行 ${solution.name} ...`);
      try {
        reports.push(
          await runSolution(
            dir,
            manifest,
            solution,
            supportPath,
            options,
            scratch,
          ),
        );
      } catch (err) {
        if (err instanceof JudgeUnavailableError) {
          throw new UsageError(err.message);
        }
        reports.push({
          name: solution.name,
          path: solution.path,
          score: 0,
          status: "error",
          time_ms: null,
          wall_ms: 0,
          stderr: "",
          notes: [],
          error: (err as Error).message,
        });
      }
    }
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }

  for (const r of reports) {
    for (const n of r.notes) if (!notes.includes(n)) notes.push(n);
  }
  const results = evaluateExpectations(reports, expectations);
  // 无断言时：所有解答都成功跑完即通过；有断言时：全部断言满足才通过。
  const pass = expectations.length > 0
    ? results.every((r) => r.pass)
    : reports.every((r) => r.error === null);

  if (args.json) {
    console.log(JSON.stringify(
      {
        pass,
        dir,
        kind: manifest.kind,
        submission_mode: manifest.submission_mode ?? null,
        notes,
        solutions: reports,
        expectations: results,
      },
      null,
      2,
    ));
  } else {
    console.log(renderHuman(reports, results, notes));
    console.log(pass ? "\n本地验题通过。" : "\n本地验题未通过。");
  }
  return pass ? EXIT_OK : EXIT_FAILURE;
}
