/**
 * noj-tests 统一测试启动器（P1-B）。
 *
 * 负责 API / Domain / Browser 三套 E2E 的统一入口：
 * 1. 环境检查（env-file）与 suite/path 选择，`--filter` 原样透传给 `deno test`；
 * 2. 生成运行清单 `test-results/performance/<runId>/manifest.json`；
 * 3. JUnit 写入 `test-results/junit/<runId>/`；
 * 4. 注入 `NOJ_TEST_PROFILE` / `NOJ_TEST_TIMING_DIR` / `NOJ_TEST_RUN_ID` /
 *    `NOJ_TEST_SHARD` / `NOJ_TEST_MANIFEST`；
 * 5. 需要 Judge 的运行只执行一次 canary：用独立题包提交正确解，确认 attempt
 *    被领取并完成，再把证据写进清单；子测试只读清单，不重复探测。
 *
 * 正式运行（`NOJ_RUN_E2E=1`）中 Judge 不可用直接失败，避免"探测失败 →
 * 静默跳过 → 显示通过"。伪造或来自其他运行的清单由 `e2e/helper.ts` 的
 * `validateJudgeCanaryManifest()` 拒绝。
 */
import {
  buildProblemBundle,
  problemBundleForm,
} from "../fixtures/problem-bundle.ts";
import { WaitHttpError, waitUntil } from "../fixtures/wait.ts";
import { measurePhase } from "../../scripts/lib/test-timing.ts";
import {
  loadSession,
  parseSessionEnv,
  renderSessionEnv,
  type SessionManifest,
} from "../../scripts/e2e/session.ts";
import {
  type BrowserGroup,
  type BrowserPlan,
  buildBrowserPlan,
  DEFAULT_BROWSER_GROUP_COUNT,
  discoverBrowserTestFiles,
  type FileDurationBaseline,
  loadBrowserDurationBaseline,
} from "./test-plan.ts";

/** 模块根目录（noj-tests），不依赖调用方 cwd。 */
export const MODULE_ROOT = decodeURIComponent(
  new URL("..", import.meta.url).pathname,
).replace(/\/+$/, "");

/** 默认 E2E 环境文件（相对 noj-tests）。 */
export const DEFAULT_ENV_FILE = "../env.e2e.template";

/** 默认 Browser 文件级耗时基线（相对 noj-tests，即仓库根 dev-docs）。 */
export const DEFAULT_BROWSER_DURATION_BASELINE =
  "../dev-docs/engineering/test-duration-baseline.json";

/** Browser 分组 shard 名：browser1…browserN。 */
const BROWSER_SHARD_PATTERN = /^browser[1-9][0-9]*$/;

/** 运行清单结构；字段与 scripts/test-performance-report.ts 的 TestRunManifest 对齐。 */
export interface RunManifest {
  version: 1;
  runId: string;
  suite: string;
  command: string;
  testCommand?: string;
  commit?: string;
  denoVersion: string;
  runner: { os: string; arch: string; ci: boolean };
  concurrency: {
    jobs?: number;
    shards?: number;
    groups?: number;
    filter?: string;
  };
  startedAt: string;
  endedAt: string;
  durationMs: number;
  discovered: string[];
  selected: string[];
  executed: string[];
  junit: string[];
  canary: JudgeCanaryEvidence | null;
  canaryError?: string;
  /** 复用的本地会话信息（--session 时写入；报告据此区分 reuse 与 clean-run）。 */
  session?: SessionManifestSummary;
  exitCode: number;
}

/** 运行清单里的会话摘要：端口/项目/网络与复用结论。 */
export interface SessionManifestSummary {
  name: string;
  runId: string;
  composeProject: string;
  networkName: string;
  ports: SessionManifest["ports"];
  reusedSession?: Record<string, boolean>;
  artifacts?: SessionManifest["artifacts"];
}

/** Judge canary 证据（与 e2e/helper.ts 的读取校验结构一致）。 */
export interface JudgeCanaryEvidence {
  runId: string;
  submissionId: string;
  attemptId: string;
  result: string;
}

/** 启动器参数。 */
export interface RunnerOptions {
  suite: string;
  domain?: string;
  filter?: string;
  profile: boolean;
  runId?: string;
  shard?: string;
  junitPath?: string;
  manifestPath?: string;
  resultsRoot: string;
  jobs?: number;
  shards?: number;
  /** Browser 分组数；默认 3，仅 browser + browserN shard 生效。 */
  groups: number;
  /** Browser 文件级耗时基线路径；默认 ../dev-docs/engineering/test-duration-baseline.json。 */
  durationBaseline?: string;
  noCanary: boolean;
  envFile?: string;
  /** 复用的本地 E2E 会话名；提供后从会话清单注入端口/URL/网络。 */
  session?: string;
  /** 会话清单目录覆盖（默认 noj-tests/test-results/e2e-sessions）。 */
  sessionDir?: string;
  paths: string[];
  forwarded: string[];
  help: boolean;
}

const KNOWN_DOMAINS = [
  "identity",
  "catalog",
  "submission",
  "contest",
  "system",
  "community",
  "objective",
  "admin",
  "rate-limit",
  "cross-domain",
  "browser",
  "staging",
] as const;

/** 解析命令行；未知 `--flag` 保持兼容，原样透传给 `deno test`。 */
export function parseRunnerArgs(args: string[]): RunnerOptions {
  const options: RunnerOptions = {
    suite: "",
    profile: false,
    resultsRoot: "test-results",
    groups: DEFAULT_BROWSER_GROUP_COUNT,
    noCanary: false,
    paths: [],
    forwarded: [],
    help: false,
  };
  let index = 0;
  const mode = args[index];
  if (!mode || mode.startsWith("-")) {
    throw new Error("缺少运行模式：api | browser | domain <name>");
  }
  if (mode === "domain") {
    const domain = args[++index];
    if (!domain || domain.startsWith("-")) {
      throw new Error("domain 模式缺少 Domain 名称");
    }
    if (!KNOWN_DOMAINS.includes(domain as (typeof KNOWN_DOMAINS)[number])) {
      throw new Error(
        `未知 Domain '${domain}'；可选：${KNOWN_DOMAINS.join(" ")}`,
      );
    }
    options.domain = domain;
    options.suite = `domain:${domain}`;
    index++;
  } else if (mode === "api" || mode === "browser") {
    options.suite = mode;
    index++;
  } else {
    throw new Error(`未知运行模式 '${mode}'：api | browser | domain <name>`);
  }

  for (; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      options.forwarded.push(...args.slice(index + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--profile") {
      options.profile = true;
      continue;
    }
    if (arg === "--no-canary") {
      options.noCanary = true;
      continue;
    }
    if (arg === "--session" || arg.startsWith("--session=")) {
      const value = arg === "--session" ? args[++index] : arg.slice(10);
      if (!value) throw new Error("--session 缺少值");
      options.session = value;
      continue;
    }
    if (arg === "--session-dir" || arg.startsWith("--session-dir=")) {
      const value = arg === "--session-dir" ? args[++index] : arg.slice(14);
      if (!value) throw new Error("--session-dir 缺少值");
      options.sessionDir = value;
      continue;
    }
    if (arg === "--filter" || arg.startsWith("--filter=")) {
      const value = arg === "--filter" ? args[++index] : arg.slice(9);
      if (!value) throw new Error("--filter 缺少值");
      options.filter = value;
      options.forwarded.push(arg === "--filter" ? "--filter" : arg);
      if (arg === "--filter") options.forwarded.push(value);
      continue;
    }
    if (arg === "--run-id") {
      options.runId = args[++index];
      if (!options.runId) throw new Error("--run-id 缺少值");
      continue;
    }
    if (arg === "--shard") {
      options.shard = args[++index];
      if (!options.shard) throw new Error("--shard 缺少值");
      continue;
    }
    if (arg === "--junit-path") {
      options.junitPath = args[++index];
      if (!options.junitPath) throw new Error("--junit-path 缺少值");
      continue;
    }
    if (arg === "--manifest-path") {
      options.manifestPath = args[++index];
      if (!options.manifestPath) throw new Error("--manifest-path 缺少值");
      continue;
    }
    if (arg === "--results-root") {
      options.resultsRoot = args[++index];
      if (!options.resultsRoot) throw new Error("--results-root 缺少值");
      continue;
    }
    if (arg === "--env-file") {
      options.envFile = args[++index];
      if (!options.envFile) throw new Error("--env-file 缺少值");
      continue;
    }
    if (arg === "--jobs") {
      options.jobs = Number(args[++index]);
      if (!Number.isInteger(options.jobs) || options.jobs < 1) {
        throw new Error("--jobs 必须是 ≥1 的整数");
      }
      continue;
    }
    if (arg === "--shards") {
      options.shards = Number(args[++index]);
      if (!Number.isInteger(options.shards) || options.shards < 1) {
        throw new Error("--shards 必须是 ≥1 的整数");
      }
      continue;
    }
    if (arg === "--groups") {
      options.groups = Number(args[++index]);
      if (!Number.isInteger(options.groups) || options.groups < 1) {
        throw new Error("--groups 必须是 ≥1 的整数");
      }
      continue;
    }
    if (arg === "--duration-baseline") {
      options.durationBaseline = args[++index];
      if (!options.durationBaseline) {
        throw new Error("--duration-baseline 缺少值");
      }
      continue;
    }
    if (arg.startsWith("-")) {
      // 兼容旧入口：deno test 选项原样透传。
      options.forwarded.push(arg);
      continue;
    }
    options.paths.push(arg);
  }

  return options;
}

/** 产物路径；显式 shard 时使用子目录，避免同机并行分片互相覆盖。 */
export interface ArtifactPaths {
  runDirectory: string;
  timingDirectory: string;
  manifestPath: string;
  junitPath: string;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

export function resolveArtifactPaths(input: {
  resultsRoot: string;
  runId: string;
  shard: string;
  explicitShard: boolean;
  manifestPath?: string;
  junitPath?: string;
}): ArtifactPaths {
  const root = input.resultsRoot.replace(/\/+$/, "");
  const runDirectory = `${root}/performance/${input.runId}` +
    (input.explicitShard ? `/${sanitizeSegment(input.shard)}` : "");
  const timingDirectory = runDirectory;
  const manifestPath = input.manifestPath ?? `${runDirectory}/manifest.json`;
  const junitName = input.explicitShard
    ? `junit-${sanitizeSegment(input.shard)}.xml`
    : "junit.xml";
  const junitPath = input.junitPath ??
    `${root}/junit/${input.runId}/${junitName}`;
  return { runDirectory, timingDirectory, manifestPath, junitPath };
}

/** 递归发现测试文件（`.test.ts`），返回模块根相对路径并排序。 */
export async function discoverTestFiles(
  roots: string[],
  cwd: string = MODULE_ROOT,
): Promise<string[]> {
  const files = new Set<string>();
  const walk = async (path: string): Promise<void> => {
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(path);
    } catch (error) {
      throw new Error(
        `测试路径不存在：${path}（${
          error instanceof Error ? error.message : String(error)
        }）`,
      );
    }
    if (stat.isFile) {
      if (path.endsWith(".test.ts")) files.add(toRelative(cwd, path));
      return;
    }
    if (!stat.isDirectory) return;
    const entries: string[] = [];
    for await (const entry of Deno.readDir(path)) entries.push(entry.name);
    entries.sort();
    for (const entry of entries) await walk(`${path}/${entry}`);
  };
  for (const root of roots) await walk(absolute(cwd, root));
  return [...files].sort();
}

function absolute(cwd: string, path: string): string {
  return path.startsWith("/") ? path : `${cwd}/${path}`;
}

function toRelative(cwd: string, path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith(`${cwd}/`)) {
    return normalized.slice(cwd.length + 1);
  }
  return normalized.replace(/^\.\//, "");
}

/** 默认运行路径。 */
export function defaultPaths(suite: string): string[] {
  if (suite === "api") return ["e2e"];
  if (suite === "browser") return ["e2e/browser"];
  if (suite.startsWith("domain:")) return [`e2e/${suite.slice(7)}`];
  throw new Error(`未知 suite：${suite}`);
}

/**
 * API 套件排除 Browser 目录。
 *
 * `test` / `test:api` 与 `test:browser` 已拆分：API 运行只跑非浏览器用例，
 * 避免被 ignore 的 Browser 文件抬高 "发现文件数" 并让 JUnit 计数失真。
 */
export function defaultExcludes(suite: string): string[] {
  return suite === "api" ? ["e2e/browser/"] : [];
}

/** 按前缀排除所选文件（前缀以 `/` 结尾）。 */
export function filterExcluded(
  files: string[],
  excludes: string[],
): string[] {
  if (excludes.length === 0) return files;
  return files.filter((file) =>
    !excludes.some((prefix) => file === prefix || file.startsWith(prefix))
  );
}

/** 是否为 Browser 分组运行：suite=browser 且 shard 形如 browserN。 */
export function isBrowserGroupRun(suite: string, shard: string): boolean {
  return suite === "browser" && BROWSER_SHARD_PATTERN.test(shard);
}

/** 解析 Browser 耗时基线路径（相对 noj-tests 模块根，并归一化 `..`）。 */
export function resolveDurationBaselinePath(path: string): string {
  if (path.startsWith("/")) return path;
  return decodeURIComponent(
    new URL(path, `file://${MODULE_ROOT}/`).pathname,
  );
}

/**
 * 从完整计划中取出指定分组。
 *
 * 组名越界或组为空时直接失败：Browser 分组运行绝不能以 0 个文件"通过"。
 */
export function resolveBrowserGroup(
  plan: BrowserPlan,
  groupName: string,
): BrowserGroup {
  const group = plan.groups.find((item) => item.groupName === groupName);
  if (!group) {
    throw new Error(
      `Browser 分组 '${groupName}' 不在计划中（本次 ${plan.groupCount} 组：${
        plan.groups.map((item) => item.groupName).join(", ")
      }）`,
    );
  }
  if (group.files.length === 0) {
    throw new Error(
      `Browser 分组 '${groupName}' 没有测试文件；拒绝运行 0 个文件的假绿`,
    );
  }
  return group;
}

/** 落盘的 Browser 分组计划：在纯计划上补充当前分组与基线路径。 */
export interface BrowserPlanFile extends BrowserPlan {
  group: string;
  baselinePath: string;
}

/** 构造计划文件内容（纯函数，便于单测断言落盘结构）。 */
export function buildBrowserPlanFile(
  plan: BrowserPlan,
  groupName: string,
  baselinePath: string,
): BrowserPlanFile {
  return { ...plan, group: groupName, baselinePath };
}

/** 把分组计划写入 timingDirectory/browser-plan.json。 */
export async function writeBrowserPlanFile(
  path: string,
  plan: BrowserPlan,
  groupName: string,
  baselinePath: string,
): Promise<BrowserPlanFile> {
  const file = buildBrowserPlanFile(plan, groupName, baselinePath);
  await Deno.mkdir(dirnameOf(path), { recursive: true });
  await Deno.writeTextFile(path, `${JSON.stringify(file, null, 2)}\n`);
  return file;
}

function defaultShard(suite: string): string {
  if (suite.startsWith("domain:")) return suite.replace(":", "-");
  return suite;
}

/** 加载 env 文件；已存在的环境变量优先（与 `deno run --env-file` 语义一致）。 */
export async function loadEnvFile(path: string): Promise<number> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return 0;
  }
  let loaded = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ")
      ? line.slice(7).trim()
      : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key || Deno.env.get(key) !== undefined) continue;
    Deno.env.set(key, value);
    loaded++;
  }
  return loaded;
}

/** 运行清单构造（纯函数，便于单测）。 */
export function buildRunManifest(input: {
  runId: string;
  suite: string;
  command: string;
  testCommand?: string;
  commit?: string;
  concurrency: {
    jobs?: number;
    shards?: number;
    groups?: number;
    filter?: string;
  };
  startedAt: string;
  endedAt: string;
  durationMs: number;
  discovered: string[];
  selected: string[];
  executed: string[];
  junit: string[];
  canary: JudgeCanaryEvidence | null;
  canaryError?: string;
  session?: SessionManifestSummary;
  exitCode: number;
}): RunManifest {
  return {
    version: 1,
    runId: input.runId,
    suite: input.suite,
    command: input.command,
    ...(input.testCommand ? { testCommand: input.testCommand } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
    denoVersion: Deno.version.deno,
    runner: {
      os: Deno.build.os,
      arch: Deno.build.arch,
      ci: Deno.env.get("CI") === "true" || Deno.env.get("CI") === "1",
    },
    concurrency: input.concurrency,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    discovered: input.discovered,
    selected: input.selected,
    executed: input.executed,
    junit: input.junit,
    canary: input.canary,
    ...(input.canaryError ? { canaryError: input.canaryError } : {}),
    ...(input.session ? { session: input.session } : {}),
    exitCode: input.exitCode,
  };
}

/** canary 提交是否已可判定（完成或失败）。 */
export interface CanarySubmissionData {
  status?: string;
  result?: { status?: string; score?: number } | null;
  latest_attempt?: {
    attempt_id?: string;
    state?: string;
    result_kind?: string | null;
    score?: number;
  } | null;
  judge_started_at?: string | null;
}

export function canarySubmissionReady(data: CanarySubmissionData): boolean {
  if (data.status === "error") return true;
  if (data.status !== "finished") return false;
  const attempt = data.latest_attempt;
  return Boolean(
    attempt && attempt.state === "finished" &&
      attempt.result_kind === "graded",
  );
}

async function gitCommit(cwd: string): Promise<string | undefined> {
  try {
    const result = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      cwd,
      stdout: "piped",
      stderr: "null",
    }).output();
    return new TextDecoder().decode(result.stdout).trim() || undefined;
  } catch {
    return undefined;
  }
}

function generateRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `${stamp}-${Deno.pid}-${crypto.randomUUID().slice(0, 8)}`;
}

function dirnameOf(path: string): string {
  const index = path.replaceAll("\\", "/").lastIndexOf("/");
  return index <= 0 ? "." : path.slice(0, index);
}

async function writeManifest(path: string, manifest: RunManifest) {
  await Deno.mkdir(dirnameOf(path), { recursive: true });
  await Deno.writeTextFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** canary 题包评测脚本：独立于样例题，只验证 solve("1 2") == "3"。 */
const CANARY_EVALUATOR = `import json
from noj_evaluator_sdk.runner import SolutionRunner

runner = SolutionRunner()
try:
    actual = str(runner.call("solve", "1 2")).strip()
    accepted = actual == "3"
    result = {
        "score": 100 if accepted else 0,
        "details": {"actual": actual, "expected": "3"},
    }
except Exception as error:
    result = {"score": 0, "details": {"error": str(error)}}
finally:
    runner.close()

print("---RESULT---")
print(json.dumps(result))
`;

const CANARY_SOLUTION = `def solve(input_str: str) -> str:
    a, b = map(int, input_str.split())
    return str(a + b)`;

function canaryBundleFiles(runId: string): Record<string, string> {
  return {
    "problem.json": JSON.stringify({
      format_version: 2,
      title: `E2E Judge Canary ${runId}`,
      difficulty: "easy",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 5000,
          memory_limit_mb: 512,
        },
      },
    }),
    "statement.md":
      `# E2E Judge Canary\n\n## 样例输入 1\n\`\`\`\n1 2\n\`\`\`\n\n## 样例输出 1\n\`\`\`\n3\n\`\`\`\n`,
    "evaluate.py": CANARY_EVALUATOR,
    "visible.jsonl": '{"input": "1 2", "output": "3"}\n',
  };
}

/**
 * 执行一次 Judge canary。
 *
 * 只跑一次：独立题包导入 → 发布 → 提交正确解 → 等待 attempt 完成。
 * 任何一步失败都抛出，由 main 写入失败清单并终止（不执行 child）。
 */
export async function runJudgeCanary(
  runId: string,
): Promise<JudgeCanaryEvidence> {
  const helper = await import("../e2e/helper.ts");
  await helper.waitForServer();
  const adminToken = await measurePhase(
    "account preparation",
    () => helper.getAdminToken(),
  );
  const archive = await measurePhase(
    "bundle build",
    () => Promise.resolve(buildProblemBundle(canaryBundleFiles(runId))),
  );
  const form = problemBundleForm(archive, `judge-canary-${runId}.zip`);
  const importRes = await fetch(
    `${helper.BASE_URL}/api/v1/domains/main/problems/import-bundle`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: form,
    },
  );
  const importBody = await importRes.json().catch(() => null) as {
    data?: { problem_id?: string };
  } | null;
  const problemId = importBody?.data?.problem_id;
  if (!problemId) {
    throw new Error(
      `Judge canary 题包导入失败：${importRes.status} ${
        JSON.stringify(importBody)
      }`,
    );
  }
  const versionId = await helper.publishProblemVersion(
    adminToken,
    problemId,
    "e2e judge canary",
  );
  const submissionId = await helper.submitCode(
    adminToken,
    problemId,
    CANARY_SOLUTION,
    "python3",
    versionId,
  );
  const data = await measurePhase(
    "submission wait",
    () =>
      waitUntil(
        async (signal) => {
          const res = await fetch(
            `${helper.BASE_URL}/api/v1/submissions/${submissionId}`,
            {
              headers: { Authorization: `Bearer ${adminToken}` },
              signal,
            },
          );
          if (!res.ok) {
            throw new WaitHttpError(
              res.status,
              `读取 canary 提交失败：${res.status}`,
            );
          }
          const body = await res.json() as { data?: CanarySubmissionData };
          return body.data ?? {};
        },
        canarySubmissionReady,
        {
          timeoutMs: 180000,
          resourceId: `Judge canary 提交 ${submissionId}`,
          describe: (value) =>
            `status=${value.status ?? "?"} attempt=${
              value.latest_attempt?.state ?? "(无)"
            }`,
        },
      ),
  );
  const attempt = data.latest_attempt;
  if (data.status !== "finished" || !attempt) {
    throw new Error(
      `Judge canary 未正常完成：status=${data.status ?? "?"}，attempt=${
        JSON.stringify(attempt ?? null)
      }`,
    );
  }
  if (
    attempt.state !== "finished" || attempt.result_kind !== "graded" ||
    (attempt.score ?? data.result?.score ?? 0) <= 0
  ) {
    throw new Error(
      `Judge canary 结果不符合预期：${JSON.stringify(attempt)}`,
    );
  }
  const attemptId = attempt.attempt_id;
  if (!attemptId) {
    throw new Error(
      "Judge canary 提交没有 attempt ID（无法证明被 Judge 领取）",
    );
  }
  console.log(
    `  ✓ Judge canary 完成：submission=${submissionId.slice(0, 8)} attempt=${
      attemptId.slice(0, 8)
    } score=${attempt.score ?? data.result?.score}`,
  );
  return { runId, submissionId, attemptId, result: "finished" };
}

interface ChildRunResult {
  exitCode: number;
  executed: string[];
}

const RUNNING_LINE = /^running \d+ tests? from (.+)$/;

async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      Deno.stdout.writeSync(encoder.encode(`${line}\n`));
      onLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer) {
    Deno.stdout.writeSync(encoder.encode(buffer));
    onLine(buffer);
  }
}

async function runDenoTest(input: {
  options: RunnerOptions;
  selected: string[];
  junitPath: string;
  env: Record<string, string>;
}): Promise<ChildRunResult> {
  const { options } = input;
  const junitDir = dirnameOf(input.junitPath);
  await Deno.mkdir(junitDir, { recursive: true });
  const args = [
    "test",
    "-A",
    ...options.forwarded,
    `--junit-path=${input.junitPath}`,
    ...input.selected,
  ];
  console.log(`  → deno ${args.join(" ")}\n`);
  const child = new Deno.Command(Deno.execPath(), {
    args,
    cwd: MODULE_ROOT,
    env: input.env,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const executed = new Set<string>();
  const onLine = (line: string) => {
    const match = RUNNING_LINE.exec(line.trim());
    if (!match) return;
    executed.add(normalizeExecutedPath(match[1]!));
  };
  const [status] = await Promise.all([
    child.status,
    pumpLines(child.stdout, onLine),
    pumpLines(child.stderr, onLine),
  ]);
  return { exitCode: status.code, executed: [...executed].sort() };
}

function normalizeExecutedPath(raw: string): string {
  let path = raw.trim();
  if (path.startsWith("file://")) path = decodeURIComponent(path.slice(7));
  return toRelative(MODULE_ROOT, path);
}

function usage(): string {
  return [
    "用法：deno run -A scripts/test-runner.ts <api|browser|domain <name>> [选项]",
    "",
    "选项：",
    "  --filter <value>        透传 deno test 用例名过滤",
    "  --profile               开启阶段计时（NOJ_TEST_PROFILE=1）",
    "  --run-id <id>           指定运行 ID（默认时间戳+PID+随机）",
    "  --shard <name>          分片名（默认 suite）",
    "  --results-root <dir>    产物根目录（默认 test-results）",
    "  --junit-path <path>     JUnit 路径覆盖",
    "  --manifest-path <path>  清单路径覆盖",
    "  --env-file <path>       E2E 环境文件（默认 ../env.e2e.template）",
    "  --jobs <n>              写入 DENO_JOBS",
    "  --shards <n>            记录分片数（P5/P6 使用）",
    "  --groups <n>            Browser 分组数（默认 3；配合 --shard browserN）",
    "  --duration-baseline <path> Browser 文件级耗时基线（默认 dev-docs/engineering/test-duration-baseline.json）",
    "  --no-canary             跳过 Judge canary（子测试会因缺证据失败）",
    "  --session <name>        复用已启动的本地会话（端口/DB/网络/URL 来自清单）",
    "  --session-dir <path>    会话清单目录（默认 noj-tests/test-results/e2e-sessions）",
    "",
    "未知 --flag 原样透传给 deno test。",
  ].join("\n");
}

/** 入口；返回退出码，便于单测。 */
export async function main(argv: string[] = Deno.args): Promise<number> {
  const options = parseRunnerArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const envFile = options.envFile ?? DEFAULT_ENV_FILE;
  const loaded = await loadEnvFile(
    envFile.startsWith("/") ? envFile : `${MODULE_ROOT}/${envFile}`,
  );
  if (loaded > 0) console.log(`  → 已从 ${envFile} 加载 ${loaded} 个环境变量`);

  // --session：复用已启动的本地会话。会话清单是端口/DB/网络/URL 的唯一事实源，
  // 因此它覆盖 env-file 里的 CI 默认值；缺失会话直接失败，不回退到默认端口。
  let sessionInfo: SessionManifestSummary | undefined;
  if (options.session) {
    const manifest = await loadSession(options.session, options.sessionDir);
    if (!manifest) {
      throw new Error(
        `session ${options.session} 不存在：先执行 deno run -A scripts/e2e/session.ts up --session ${options.session}`,
      );
    }
    for (
      const [key, value] of Object.entries(
        parseSessionEnv(renderSessionEnv(manifest)),
      )
    ) {
      Deno.env.set(key, value);
    }
    sessionInfo = {
      name: manifest.session,
      runId: manifest.runId,
      composeProject: manifest.composeProject,
      networkName: manifest.networkName,
      ports: manifest.ports,
      reusedSession: manifest.reusedSession,
      artifacts: manifest.artifacts,
    };
    console.log(
      `  → 会话 ${manifest.session}：project=${manifest.composeProject} core=:${manifest.ports.core} network=${manifest.networkName}`,
    );
    console.log(
      `  → reused-session: ui=${
        manifest.reusedSession?.ui ? "yes" : "no"
      } support-packages=${
        manifest.reusedSession?.["support-packages"] ? "yes" : "no"
      }`,
    );
  }

  if (Deno.env.get("NOJ_RUN_E2E") !== "1") {
    throw new Error(
      "NOJ_RUN_E2E != 1：拒绝运行 E2E 启动器（避免全部用例被 ignore 后假绿）",
    );
  }

  const runId = options.runId ?? Deno.env.get("NOJ_TEST_RUN_ID") ??
    generateRunId();
  const explicitShard = options.shard !== undefined ||
    Deno.env.get("NOJ_TEST_SHARD") !== undefined;
  const shard = options.shard ?? Deno.env.get("NOJ_TEST_SHARD") ??
    defaultShard(options.suite);
  const resultsRoot = options.resultsRoot.startsWith("/")
    ? options.resultsRoot
    : `${MODULE_ROOT}/${options.resultsRoot}`;
  const artifacts = resolveArtifactPaths({
    resultsRoot,
    runId,
    shard,
    explicitShard,
    manifestPath: options.manifestPath,
    junitPath: options.junitPath,
  });
  await Deno.mkdir(artifacts.timingDirectory, { recursive: true });

  Deno.env.set("NOJ_TEST_RUN_ID", runId);
  Deno.env.set("NOJ_TEST_TIMING_DIR", artifacts.timingDirectory);
  Deno.env.set("NOJ_TEST_SHARD", shard);
  Deno.env.set("NOJ_TEST_MANIFEST", artifacts.manifestPath);
  if (options.profile) Deno.env.set("NOJ_TEST_PROFILE", "1");

  const startedAt = new Date();
  const started = performance.now();
  let discovered: string[];
  let selected: string[];
  let browserPlan: BrowserPlan | null = null;
  let browserPlanPath: string | undefined;

  if (isBrowserGroupRun(options.suite, shard)) {
    // Browser 分组：按文件级耗时基线把全部 Browser 用例分到 N 组，只跑本组。
    const files = await discoverBrowserTestFiles(MODULE_ROOT);
    const baselinePath = resolveDurationBaselinePath(
      options.durationBaseline ?? DEFAULT_BROWSER_DURATION_BASELINE,
    );
    const baseline: FileDurationBaseline = await loadBrowserDurationBaseline(
      baselinePath,
    );
    browserPlan = buildBrowserPlan(files, baseline, options.groups);
    const group = resolveBrowserGroup(browserPlan, shard);
    discovered = browserPlan.selectedFiles;
    selected = group.files;
    browserPlanPath = `${artifacts.timingDirectory}/browser-plan.json`;
    await writeBrowserPlanFile(
      browserPlanPath,
      browserPlan,
      shard,
      baselinePath,
    );
    console.log(
      `  → Browser 分组 ${shard}/${browserPlan.groupCount}：${selected.length} 个文件（发现 ${discovered.length}，基线 ${baselinePath}）`,
    );
  } else {
    discovered = filterExcluded(
      await discoverTestFiles(
        options.paths.length ? options.paths : defaultPaths(options.suite),
      ),
      defaultExcludes(options.suite),
    );
    selected = discovered;
  }
  if (selected.length === 0) {
    throw new Error(
      `未发现测试文件：${defaultPaths(options.suite).join(", ")}（排除 ${
        defaultExcludes(options.suite).join(", ") || "无"
      }）`,
    );
  }

  const command = ["deno", "run", "-A", "scripts/test-runner.ts", ...argv].join(
    " ",
  );
  const commit = await gitCommit(MODULE_ROOT);
  const concurrency = {
    ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
    ...(options.shards === undefined ? {} : { shards: options.shards }),
    ...(browserPlan === null ? {} : { groups: browserPlan.groupCount }),
    ...(options.filter === undefined ? {} : { filter: options.filter }),
  };

  let canary: JudgeCanaryEvidence | null = null;
  if (options.noCanary) {
    console.log(
      "  ⚠ 已显式跳过 Judge canary（读取 canary 清单的子测试会因此失败）",
    );
  } else {
    try {
      canary = await measurePhase("judge canary", () => runJudgeCanary(runId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const endedAt = new Date();
      await writeManifest(
        artifacts.manifestPath,
        buildRunManifest({
          runId,
          suite: options.suite,
          command,
          commit,
          concurrency,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: performance.now() - started,
          discovered,
          selected,
          executed: [],
          junit: [],
          canary: null,
          canaryError: message,
          session: sessionInfo,
          exitCode: 1,
        }),
      );
      console.error(`  ✗ Judge canary 失败：${message}`);
      console.error(`    运行清单：${artifacts.manifestPath}`);
      return 1;
    }
  }

  // child 的 setup 会读取 canary 证据：必须在启动测试进程之前落盘一次
  // 清单（exitCode 用 -1 表示"运行中"），测试结束后再覆盖为最终结果。
  await writeManifest(
    artifacts.manifestPath,
    buildRunManifest({
      runId,
      suite: options.suite,
      command,
      commit,
      concurrency,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: performance.now() - started,
      discovered,
      selected,
      executed: [],
      junit: [],
      canary,
      session: sessionInfo,
      exitCode: -1,
    }),
  );

  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    NOJ_TEST_RUN_ID: runId,
    NOJ_TEST_TIMING_DIR: artifacts.timingDirectory,
    NOJ_TEST_SHARD: shard,
    NOJ_TEST_MANIFEST: artifacts.manifestPath,
  };
  if (options.profile) env.NOJ_TEST_PROFILE = "1";
  if (options.jobs !== undefined) env.DENO_JOBS = String(options.jobs);

  const child = await runDenoTest({
    options,
    selected,
    junitPath: artifacts.junitPath,
    env,
  });
  const endedAt = new Date();
  const junitExists = await (async () => {
    try {
      return (await Deno.stat(artifacts.junitPath)).isFile;
    } catch {
      return false;
    }
  })();
  const manifest = buildRunManifest({
    runId,
    suite: options.suite,
    command,
    testCommand: ["deno", "test", "-A", ...options.forwarded].join(" "),
    commit,
    concurrency,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: performance.now() - started,
    discovered,
    selected,
    executed: child.executed,
    junit: junitExists ? [artifacts.junitPath] : [],
    canary,
    session: sessionInfo,
    exitCode: child.exitCode,
  });
  await writeManifest(artifacts.manifestPath, manifest);
  console.log(
    `\n  → 运行清单：${artifacts.manifestPath}\n  → JUnit：${
      junitExists ? artifacts.junitPath : "(未生成)"
    }\n  → 测试文件：发现 ${discovered.length} / 执行 ${child.executed.length}，退出码 ${child.exitCode}`,
  );
  return child.exitCode;
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (error) {
    console.error(
      `  ✗ 启动器失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    Deno.exit(2);
  }
}
