import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  buildPreflightReport,
  PREFLIGHT_NOTICE,
  preflightExitCode,
  type PreflightReport,
  renderPreflightCsv,
} from "../../scripts/preflight-upgrade.ts";

/**
 * 预检纯函数测试。
 *
 * 这里**不连数据库**：`runPreflight` 的 I/O 已被 `PreflightDeps` 抽出，
 * 判定逻辑全在 `buildPreflightReport` / `preflightExitCode` / `renderPreflightCsv`
 * 三个纯函数里，因此可以用零外部依赖的方式固定住「什么算阻塞」的口径。
 */

const NOW = new Date("2026-10-31T00:00:00.000Z");

/** `buildPreflightReport` 的事实入参（显式类型，避免字面量数组被推成 never[]）。 */
type ReportInput = Parameters<typeof buildPreflightReport>[0];

/** 一份"库干净、未命中阻塞"的基线输入。 */
function cleanInput(): ReportInput {
  return {
    migrationApplied: 126,
    migrationLastCreatedAt: "1789000000000",
    hasProblemsTypeColumn: false,
    hasContestsTable: true,
    legacyProblemCount: 0,
    legacyProblemSamples: [],
    contestCount: 0,
    contestSamples: [],
    contestProblemCount: 0,
    contestParticipantCount: 0,
    contestSubmissionCount: 0,
    domainCount: 1,
    legacyColumns: [],
  };
}

/** 复用 buildPreflightReport，避免测试里重复构造入参。 */
function build(overrides: Partial<ReportInput>): PreflightReport {
  return buildPreflightReport({ ...cleanInput(), ...overrides }, NOW);
}

Deno.test("preflight: 干净库不产生阻塞，退出码 0", () => {
  const report = build({});
  assertEquals(report.blockers, []);
  assertEquals(preflightExitCode(report), 0);
  assertEquals(report.migration.applied, 126);
  assertEquals(report.generated_at, NOW.toISOString());
});

Deno.test("preflight: 旧 U 型题命中阻塞，退出码 2", () => {
  const report = build({
    hasProblemsTypeColumn: true,
    legacyProblemCount: 3,
    legacyProblemSamples: ["P1001(id-1) 旧题"],
  });
  assertEquals(report.blockers.length, 1);
  assertEquals(report.blockers[0]!.code, "legacy_u_problems");
  assertEquals(report.blockers[0]!.count, 3);
  assertEquals(report.blockers[0]!.samples, ["P1001(id-1) 旧题"]);
  assertEquals(preflightExitCode(report), 2);
});

Deno.test("preflight: 旧比赛命中阻塞，两条阻塞并存时都报告", () => {
  const report = build({
    hasProblemsTypeColumn: true,
    legacyProblemCount: 1,
    contestCount: 2,
    contestSamples: ["ct-abc 春季赛", "ct-def 秋季赛"],
  });
  assertEquals(report.blockers.map((b) => b.code), [
    "legacy_u_problems",
    "legacy_contests",
  ]);
  assertEquals(preflightExitCode(report), 2);
});

Deno.test("preflight: 仅旧比赛也单独阻塞（不需同时有 U 型题）", () => {
  const report = build({ contestCount: 1, contestSamples: ["ct-x"] });
  assertEquals(report.blockers.length, 1);
  assertEquals(report.blockers[0]!.code, "legacy_contests");
  assertEquals(preflightExitCode(report), 2);
});

Deno.test("preflight: problems.type 缺失时旧 U 判定标记为不适用而非 0 命中", () => {
  const report = build({
    hasProblemsTypeColumn: false,
    legacyProblemCount: 0,
  });
  const probe = report.probes.find((p) => p.name === "problems.type 列");
  assert(probe !== undefined);
  assertEquals(probe!.applicable, false);
  assertEquals(probe!.count, null);
  assert((probe!.note ?? "").includes("0116"));
});

Deno.test("preflight: 依赖计数缺失记为 null 且仍可用于人工判断", () => {
  const report = build({
    contestProblemCount: null,
    contestParticipantCount: null,
    contestSubmissionCount: null,
    domainCount: null,
  });
  for (
    const name of [
      "contest_problems 依赖",
      "contest_participants 依赖",
      "带 contest_id 的提交",
      "domains",
    ]
  ) {
    const probe = report.probes.find((p) => p.name === name);
    assert(probe !== undefined, name);
    assertEquals(probe!.applicable, false, name);
    assertEquals(probe!.count, null, name);
  }
});

Deno.test("preflight: 报告带明确性质声明，不能当备份用", () => {
  const report = build({});
  assertEquals(report.notice, PREFLIGHT_NOTICE);
  assert(report.notice.includes("不是备份"), report.notice);
  assert(report.notice.includes("未修改任何业务数据"), report.notice);
});

Deno.test("preflight CSV: 含逗号与引号的字段被正确转义", () => {
  const report: PreflightReport = build({
    hasProblemsTypeColumn: true,
    legacyProblemCount: 1,
    legacyProblemSamples: ['P1 "带引号", 还有逗号'],
  });
  const csv = renderPreflightCsv(report);
  const lines = csv.trimEnd().split("\n");
  assertEquals(lines[0], "kind,name_or_code,count,detail");
  assert(csv.includes("blocker,legacy_u_problems,1,"), csv);
  assert(csv.includes('""带引号"", 还有逗号'), csv);
});

Deno.test("preflight CSV: 干净库的 CSV 只含 migration 与 probe 行", () => {
  const report = build({});
  const csv = renderPreflightCsv(report);
  assert(!csv.includes("blocker,"), csv);
  assert(csv.includes("probe,domains,1,"), csv);
});
