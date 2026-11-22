/**
 * 统一启动器与运行清单校验的零依赖测试（P1-B）。
 *
 * 不启动 E2E 栈：只验证参数解析、产物路径、清单构造、canary 完成判定，
 * 以及子测试读取清单时对"伪造/串运行/缺提交 ID"的拒绝逻辑。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  buildBrowserPlanFile,
  buildRunManifest,
  canarySubmissionReady,
  defaultExcludes,
  defaultPaths,
  discoverTestFiles,
  filterExcluded,
  parseRunnerArgs,
  resolveArtifactPaths,
  resolveBrowserGroup,
  writeBrowserPlanFile,
} from "../../scripts/test-runner.ts";
import {
  buildBrowserPlan,
  type FileDurationBaseline,
} from "../../scripts/test-plan.ts";
import { validateJudgeCanaryManifest } from "../../e2e/helper.ts";

const SUBMISSION_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";

const BROWSER_FILES = [
  "e2e/browser/a.test.ts",
  "e2e/browser/b.test.ts",
  "e2e/browser/c.test.ts",
  "e2e/browser/d.test.ts",
  "e2e/browser/e.test.ts",
  "e2e/browser/f.test.ts",
];

const BROWSER_BASELINE: FileDurationBaseline = {
  version: 1,
  generatedAt: "2026-11-03T00:00:00.000Z",
  source: "unit-test",
  files: {
    "e2e/browser/a.test.ts": 600,
    "e2e/browser/b.test.ts": 500,
    "e2e/browser/c.test.ts": 400,
    "e2e/browser/d.test.ts": 300,
    "e2e/browser/e.test.ts": 200,
    "e2e/browser/f.test.ts": 100,
  },
};

function validManifest(runId = "run-1") {
  return {
    version: 1,
    runId,
    canary: {
      runId,
      submissionId: SUBMISSION_ID,
      attemptId: ATTEMPT_ID,
      result: "finished",
    },
  };
}

Deno.test("test-runner: 解析 domain 模式与过滤参数", () => {
  const options = parseRunnerArgs([
    "domain",
    "contest",
    "--filter=e2e/contest",
    "--profile",
    "--run-id",
    "run-1",
    "--shard",
    "shard-a",
    "--jobs",
    "2",
    "--shards",
    "3",
  ]);
  assertEquals(options.suite, "domain:contest");
  assertEquals(options.domain, "contest");
  assertEquals(options.filter, "e2e/contest");
  assertEquals(options.profile, true);
  assertEquals(options.runId, "run-1");
  assertEquals(options.shard, "shard-a");
  assertEquals(options.jobs, 2);
  assertEquals(options.shards, 3);
  assertEquals(options.forwarded, ["--filter=e2e/contest"]);
});

Deno.test("test-runner: api 模式保留未知 deno test 选项与路径", () => {
  const options = parseRunnerArgs([
    "api",
    "--no-check",
    "e2e/submission",
    "--",
    "--filter",
    "something",
  ]);
  assertEquals(options.suite, "api");
  assertEquals(options.paths, ["e2e/submission"]);
  assertEquals(options.forwarded, ["--no-check", "--filter", "something"]);
  assertEquals(defaultPaths("api"), ["e2e"]);
  assertEquals(defaultPaths("domain:catalog"), ["e2e/catalog"]);
});

Deno.test("test-runner: API 套件排除 Browser 目录", () => {
  assertEquals(defaultExcludes("api"), ["e2e/browser/"]);
  assertEquals(defaultExcludes("browser"), []);
  assertEquals(
    filterExcluded(
      ["e2e/browser/ui_flows.test.ts", "e2e/catalog/tags.test.ts"],
      defaultExcludes("api"),
    ),
    ["e2e/catalog/tags.test.ts"],
  );
});

Deno.test("test-runner: Browser 默认 3 组且 --groups/--duration-baseline 可覆盖", () => {
  const defaults = parseRunnerArgs(["browser", "--shard", "browser1"]);
  assertEquals(defaults.groups, 3);
  assertEquals(defaults.durationBaseline, undefined);

  const overridden = parseRunnerArgs([
    "browser",
    "--shard",
    "browser2",
    "--groups",
    "5",
    "--duration-baseline",
    "/tmp/baseline.json",
  ]);
  assertEquals(overridden.groups, 5);
  assertEquals(overridden.durationBaseline, "/tmp/baseline.json");
});

Deno.test("test-runner: browser2 只选择该组文件且覆盖全部文件", () => {
  const plan = buildBrowserPlan(BROWSER_FILES, BROWSER_BASELINE, 3);
  assertEquals(plan.groupCount, 3);
  const group = resolveBrowserGroup(plan, "browser2");
  assertEquals(group.groupName, "browser2");
  // 600/500/400/300/200/100 的贪心分配：b1=[a,f]，b2=[b,e]，b3=[c,d]。
  assertEquals(group.files, [
    "e2e/browser/b.test.ts",
    "e2e/browser/e.test.ts",
  ]);
  assertEquals(
    plan.groups.flatMap((item) => item.files).sort(),
    [...BROWSER_FILES].sort(),
  );
});

Deno.test("test-runner: Browser 越界组与空组直接失败", async () => {
  const plan = buildBrowserPlan(BROWSER_FILES, BROWSER_BASELINE, 3);
  await assertRejects(
    () => Promise.resolve().then(() => resolveBrowserGroup(plan, "browser4")),
    Error,
    "不在计划中",
  );

  // 2 个文件分 3 组时 browser3 为空，不能以 0 个文件通过。
  const sparse = buildBrowserPlan(
    BROWSER_FILES.slice(0, 2),
    BROWSER_BASELINE,
    3,
  );
  await assertRejects(
    () => Promise.resolve().then(() => resolveBrowserGroup(sparse, "browser3")),
    Error,
    "0 个文件",
  );
});

Deno.test("test-runner: Browser 分组计划落盘包含来源与本组文件", async () => {
  const plan = buildBrowserPlan(BROWSER_FILES, BROWSER_BASELINE, 3);
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/browser-plan.json`;
    const written = await writeBrowserPlanFile(
      path,
      plan,
      "browser2",
      "/tmp/baseline.json",
    );
    assertEquals(written.group, "browser2");
    const raw = JSON.parse(await Deno.readTextFile(path)) as {
      groupCount: number;
      selectedFiles: string[];
      groups: { groupName: string }[];
      baseline: { source: string };
      group: string;
      baselinePath: string;
    };
    assertEquals(raw.groupCount, 3);
    assertEquals(raw.selectedFiles.length, BROWSER_FILES.length);
    assertEquals(raw.groups.length, 3);
    assertEquals(raw.groups[1]!.groupName, "browser2");
    assertEquals(raw.baseline.source, "unit-test");
    assertEquals(raw.group, "browser2");
    assertEquals(raw.baselinePath, "/tmp/baseline.json");
    assertEquals(
      buildBrowserPlanFile(plan, "browser2", "/tmp/baseline.json")
        .selectedFiles,
      plan.selectedFiles,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("test-runner: 显式分片使用独立清单与 JUnit 路径", () => {
  const base = resolveArtifactPaths({
    resultsRoot: "/tmp/results",
    runId: "run-1",
    shard: "domain-contest",
    explicitShard: false,
  });
  assertEquals(
    base.manifestPath,
    "/tmp/results/performance/run-1/manifest.json",
  );
  assertEquals(base.junitPath, "/tmp/results/junit/run-1/junit.xml");

  const sharded = resolveArtifactPaths({
    resultsRoot: "/tmp/results",
    runId: "run-1",
    shard: "domain-contest",
    explicitShard: true,
  });
  assertEquals(
    sharded.manifestPath,
    "/tmp/results/performance/run-1/domain-contest/manifest.json",
  );
  assertEquals(
    sharded.junitPath,
    "/tmp/results/junit/run-1/junit-domain-contest.xml",
  );
});

Deno.test("test-runner: 运行清单包含归因所需字段", () => {
  const manifest = buildRunManifest({
    runId: "run-1",
    suite: "api",
    command: "deno run -A scripts/test-runner.ts api",
    testCommand: "deno test -A e2e",
    commit: "abc123",
    concurrency: { jobs: 2, groups: 3, filter: "e2e" },
    startedAt: "2026-11-03T00:00:00.000Z",
    endedAt: "2026-11-03T00:00:10.000Z",
    durationMs: 10000,
    discovered: ["e2e/a.test.ts"],
    selected: ["e2e/a.test.ts"],
    executed: ["e2e/a.test.ts"],
    junit: ["/tmp/junit.xml"],
    canary: {
      runId: "run-1",
      submissionId: SUBMISSION_ID,
      attemptId: ATTEMPT_ID,
      result: "finished",
    },
    exitCode: 0,
  });
  assertEquals(manifest.version, 1);
  assertEquals(manifest.runId, "run-1");
  assertEquals(manifest.denoVersion, Deno.version.deno);
  assertEquals(manifest.runner.os, Deno.build.os);
  assertEquals(manifest.concurrency.jobs, 2);
  assertEquals(manifest.concurrency.groups, 3);
  assertEquals(manifest.discovered, ["e2e/a.test.ts"]);
  assertEquals(manifest.canary?.submissionId, SUBMISSION_ID);
  assertEquals(manifest.exitCode, 0);
});

Deno.test("test-runner: canary 只认已完成的 graded attempt", () => {
  assertEquals(
    canarySubmissionReady({
      status: "finished",
      latest_attempt: { state: "queued" },
    }),
    false,
  );
  assertEquals(
    canarySubmissionReady({
      status: "finished",
      latest_attempt: { state: "finished", result_kind: "graded" },
    }),
    true,
  );
  assertEquals(
    canarySubmissionReady({
      status: "error",
      latest_attempt: { state: "queued" },
    }),
    true,
  );
});

Deno.test("test-runner: 发现测试文件时忽略非 .test.ts", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/nested`, { recursive: true });
    await Deno.writeTextFile(`${dir}/nested/b.test.ts`, "");
    await Deno.writeTextFile(`${dir}/a.test.ts`, "");
    await Deno.writeTextFile(`${dir}/helper.ts`, "");
    const files = await discoverTestFiles([dir], dir);
    assertEquals(files, ["a.test.ts", "nested/b.test.ts"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("canary 清单: 合法证据通过校验", () => {
  const evidence = validateJudgeCanaryManifest(validManifest(), {
    runId: "run-1",
  });
  assertEquals(evidence.submissionId, SUBMISSION_ID);
  assertEquals(evidence.attemptId, ATTEMPT_ID);
});

Deno.test("canary 清单: 拒绝跨运行/伪造清单", async () => {
  // 同步校验抛错转成 rejection，便于断言错误信息。
  const reject = (fn: () => unknown) => Promise.resolve().then(fn);
  await assertRejects(
    () =>
      reject(() =>
        validateJudgeCanaryManifest(validManifest("other-run"), {
          runId: "run-1",
        })
      ),
    Error,
    "runId 不匹配",
  );
  const mismatched = validManifest();
  mismatched.canary.runId = "forged-run";
  await assertRejects(
    () =>
      reject(() => validateJudgeCanaryManifest(mismatched, { runId: "run-1" })),
    Error,
    "canary runId 与清单不一致",
  );
  const noSubmission = validManifest();
  noSubmission.canary.submissionId = "";
  await assertRejects(
    () =>
      reject(() =>
        validateJudgeCanaryManifest(noSubmission, { runId: "run-1" })
      ),
    Error,
    "提交 ID 非法",
  );
  await assertRejects(
    () =>
      reject(() =>
        validateJudgeCanaryManifest(validManifest(), {
          runId: "run-1",
          submissionId: "33333333-3333-4333-8333-333333333333",
        })
      ),
    Error,
    "提交 ID 不匹配",
  );
  const errored = validManifest();
  errored.canary.result = "error";
  await assertRejects(
    () =>
      reject(() => validateJudgeCanaryManifest(errored, { runId: "run-1" })),
    Error,
    "结果不是完成的正常评测",
  );
});
