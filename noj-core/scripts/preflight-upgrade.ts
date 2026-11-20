/**
 * 0.11 升级前置只读预检（preflight）。
 *
 * ## 为什么需要它
 *
 * 迁移 `0116_peaceful_gorilla_man.sql` 开头是兼容性守卫：
 *
 * ```sql
 * IF EXISTS (SELECT 1 FROM problems WHERE type = 'U') THEN RAISE EXCEPTION ...
 * IF EXISTS (SELECT 1 FROM contests) THEN RAISE EXCEPTION ...
 * ```
 *
 * 即：存量库只要还有旧 `U` 型题或**任意**一行比赛，迁移会以 `55000` 中止。
 * 这不是缺陷而是刻意的数据契约——它拒绝在未确认业务数据归属的情况下自动搬运或
 * 删除。运维在这种中止面前需要的不是"绕过 SQL"，而是**在动手前知道命中了什么**。
 *
 * ## 行为约束
 *
 * - **只读**：整个流程在一个 `READ ONLY` 事务里完成，任何写语句都会被 PG 拒绝；
 * - **不改业务数据**：不建表、不写文件到数据库所在主机、不触碰对象存储；
 * - **不是备份**：报告用于决策，不能替代 `noj-cli backup create` 与恢复演练；
 * - **结构探测**：0.10.x 与 0.11 的列集合不同（`problems.type` 在 0116 被删），
 *   脚本按 `information_schema` 探测后再查询，缺失列按「不适用」处理而不是报错。
 *
 * ## 退出码
 *
 * - `0`：未命中阻塞条件（或库尚未初始化，无需预检）；
 * - `2`：命中阻塞条件（旧 U 型题 / 旧比赛存在），迁移会中止；
 * - `1`：预检本身失败（连接、权限、SQL 错误）——不能用健康探针替代。
 *
 * ## 用法
 *
 * ```bash
 * # 在 noj-core 目录，读取 .env 里的 DATABASE_URL
 * deno run --env-file=.env -A scripts/preflight-upgrade.ts
 * deno run --env-file=.env -A scripts/preflight-upgrade.ts --json /tmp/noj-preflight.json
 * deno run --env-file=.env -A scripts/preflight-upgrade.ts --csv /tmp/noj-preflight.csv
 * ```
 */

import postgres from "postgres";

/** 单条阻塞事实（迁移会因此中止）。 */
export interface PreflightBlocker {
  /** 稳定标识，供自动化判定 */
  code: "legacy_u_problems" | "legacy_contests";
  /** 数量 */
  count: number;
  /** 人类可读说明 */
  detail: string;
  /** 示例标识（最多 20 条），便于运维定位 */
  samples: string[];
}

/** 某张表/某个查询的「存在性」事实。 */
export interface PreflightProbe {
  /** 探测项名称 */
  name: string;
  /** 是否适用（列/表不存在时为 false） */
  applicable: boolean;
  /** 数量；不适用或查询失败时为 null */
  count: number | null;
  /** 备注（不适用原因等） */
  note?: string;
}

/** 完整预检报告。 */
export interface PreflightReport {
  /** 报告生成时刻（UTC ISO 8601） */
  generated_at: string;
  /** 迁移 ledger 位置（`drizzle.__drizzle_migrations` 最后一条） */
  migration: { applied: number; last_created_at: string | null };
  /** 结构探测结果 */
  probes: PreflightProbe[];
  /** 阻塞事实；非空即退出码 2 */
  blockers: PreflightBlocker[];
  /** 弃用/遗留字段清单（仅提示，不阻塞） */
  legacy_columns: string[];
  /** 明确声明报告性质 */
  notice: string;
}

/** 报告性质声明：避免把预检当备份。 */
export const PREFLIGHT_NOTICE =
  "本报告由只读事务生成，仅用于升级决策；它不是备份，也不能替代 " +
  "`noj-cli backup create` 与 `noj-cli backup drill`。检查过程未修改任何业务数据。";

type Row = Record<string, unknown>;

/** 预检所需的最小数据库访问面（便于零依赖单测）。 */
export interface PreflightDeps {
  /** 在只读事务内执行查询并返回行 */
  query: (sql: string) => Promise<Row[]>;
  /** 当前时刻（注入以便测试固定时间） */
  now: () => Date;
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 纯函数：把列探测结果与计数汇成报告。
 *
 * @param input 原始事实
 * @param now 生成时刻
 * @returns 报告对象（不含 I/O）
 */
export function buildPreflightReport(
  input: {
    migrationApplied: number;
    migrationLastCreatedAt: string | null;
    hasProblemsTypeColumn: boolean;
    hasContestsTable: boolean;
    legacyProblemCount: number;
    legacyProblemSamples: string[];
    contestCount: number;
    contestSamples: string[];
    contestProblemCount: number | null;
    contestParticipantCount: number | null;
    contestSubmissionCount: number | null;
    domainCount: number | null;
    legacyColumns: string[];
  },
  now: Date,
): PreflightReport {
  const blockers: PreflightBlocker[] = [];
  if (input.legacyProblemCount > 0) {
    blockers.push({
      code: "legacy_u_problems",
      count: input.legacyProblemCount,
      detail:
        "存在旧 `U` 型题。0116 会以 55000 中止迁移；需先确认这些题目的业务归属并完成授权数据处理。",
      samples: input.legacyProblemSamples,
    });
  }
  if (input.contestCount > 0) {
    blockers.push({
      code: "legacy_contests",
      count: input.contestCount,
      detail:
        "存在比赛行。0116 要求比赛归属已按使用域整理；任何遗留行都会中止迁移。",
      samples: input.contestSamples,
    });
  }

  const probes: PreflightProbe[] = [
    {
      name: "problems.type 列",
      applicable: input.hasProblemsTypeColumn,
      count: input.hasProblemsTypeColumn ? input.legacyProblemCount : null,
      note: input.hasProblemsTypeColumn
        ? undefined
        : "列不存在：说明该库已施加 0116 之后的迁移，旧 U 型判定不适用",
    },
    {
      name: "contests 表",
      applicable: input.hasContestsTable,
      count: input.hasContestsTable ? input.contestCount : null,
      note: input.hasContestsTable
        ? undefined
        : "表不存在：该库尚未包含比赛能力",
    },
    {
      name: "contest_problems 依赖",
      applicable: input.contestProblemCount !== null,
      count: input.contestProblemCount,
    },
    {
      name: "contest_participants 依赖",
      applicable: input.contestParticipantCount !== null,
      count: input.contestParticipantCount,
    },
    {
      name: "带 contest_id 的提交",
      applicable: input.contestSubmissionCount !== null,
      count: input.contestSubmissionCount,
    },
    {
      name: "domains",
      applicable: input.domainCount !== null,
      count: input.domainCount,
    },
  ];

  return {
    generated_at: now.toISOString(),
    migration: {
      applied: input.migrationApplied,
      last_created_at: input.migrationLastCreatedAt,
    },
    probes,
    blockers,
    legacy_columns: input.legacyColumns,
    notice: PREFLIGHT_NOTICE,
  };
}

/** 渲染 CSV（一行一个探测/阻塞项，便于表格工具打开）。 */
export function renderPreflightCsv(report: PreflightReport): string {
  const lines = [
    "kind,name_or_code,count,detail",
    `migration,applied,${report.migration.applied},${
      report.migration.last_created_at ?? ""
    }`,
  ];
  for (const probe of report.probes) {
    lines.push(
      `probe,${csvCell(probe.name)},${probe.count ?? ""},${
        csvCell(probe.note ?? "")
      }`,
    );
  }
  for (const blocker of report.blockers) {
    lines.push(
      `blocker,${csvCell(blocker.code)},${blocker.count},${
        csvCell(`${blocker.detail} 样例：${blocker.samples.join(" ")}`)
      }`,
    );
  }
  for (const column of report.legacy_columns) {
    lines.push(`legacy_column,${csvCell(column)},,仅提示，不阻塞迁移`);
  }
  return lines.join("\n") + "\n";
}

/** CSV 单元格转义：含逗号/引号/换行时用双引号包裹并转义引号。 */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** 报告是否需要非零退出（命中阻塞条件）。 */
export function preflightExitCode(report: PreflightReport): number {
  return report.blockers.length > 0 ? 2 : 0;
}

/** 从真实数据库收集事实并生成报告（只读事务）。 */
export async function runPreflight(
  deps?: PreflightDeps,
): Promise<PreflightReport> {
  const now = deps?.now ?? (() => new Date());
  const query = deps?.query ?? defaultQuery();

  // 1. 迁移 ledger（0.11 之前已存在的表；不存在视为未初始化）
  const ledgerTable = await query(
    "SELECT to_regclass('drizzle.__drizzle_migrations') AS reg",
  );
  const hasLedger = asString(ledgerTable[0]?.reg) !== null;
  let migrationApplied = 0;
  let migrationLastCreatedAt: string | null = null;
  if (hasLedger) {
    const rows = await query(
      "SELECT count(*)::int AS applied, max(created_at)::text AS last FROM drizzle.__drizzle_migrations",
    );
    migrationApplied = asNumber(rows[0]?.applied);
    migrationLastCreatedAt = asString(rows[0]?.last);
  }

  // 2. 结构探测：0.10.x 有 problems.type，0116 之后没有
  const columnRows = await query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'problems'",
  );
  const problemColumns = new Set(
    columnRows.map((row) => String(row.column_name)),
  );
  const hasProblemsTypeColumn = problemColumns.has("type");

  const hasContestsTable = (await query(
    "SELECT to_regclass('public.contests') AS reg",
  )).some((row) => asString(row.reg) !== null);

  // 3. 阻塞事实：旧 U 型题（含标识样例，帮助运维定位）
  let legacyProblemCount = 0;
  let legacyProblemSamples: string[] = [];
  let legacyColumns: string[] = [];
  if (hasProblemsTypeColumn) {
    const rows = await query(
      "SELECT count(*)::int AS c FROM problems WHERE type = 'U'",
    );
    legacyProblemCount = asNumber(rows[0]?.c);
    if (legacyProblemCount > 0) {
      const samples = await query(
        "SELECT id, number, title FROM problems WHERE type = 'U' ORDER BY number LIMIT 20",
      );
      legacyProblemSamples = samples.map((row) =>
        `P${row.number ?? "?"}(${row.id}) ${row.title ?? ""}`.trim()
      );
    }
    legacyColumns = ["problems.type（旧分类列，0116 后删除）"];
  }

  // 4. 阻塞事实：比赛行
  let contestCount = 0;
  let contestSamples: string[] = [];
  let contestProblemCount: number | null = null;
  let contestParticipantCount: number | null = null;
  let contestSubmissionCount: number | null = null;
  if (hasContestsTable) {
    const rows = await query(
      "SELECT count(*)::int AS c FROM public.contests",
    );
    contestCount = asNumber(rows[0]?.c);
    if (contestCount > 0) {
      const samples = await query(
        "SELECT public_id, title FROM public.contests ORDER BY start_time LIMIT 20",
      );
      contestSamples = samples.map((row) =>
        `${row.public_id ?? "?"} ${row.title ?? ""}`.trim()
      );
    }
    contestProblemCount = await safeCount(
      query,
      "SELECT count(*)::int AS c FROM contest_problems",
    );
    contestParticipantCount = await safeCount(
      query,
      "SELECT count(*)::int AS c FROM contest_participants",
    );
    contestSubmissionCount = await safeCount(
      query,
      "SELECT count(*)::int AS c FROM submissions WHERE contest_id IS NOT NULL",
    );
    legacyColumns.push(
      "contests.kind / contests.is_public / contests.password（旧分类与口令列，已不参与授权）",
    );
  }

  const domainCount = await safeCount(
    query,
    "SELECT count(*)::int AS c FROM domains",
  );

  return buildPreflightReport({
    migrationApplied,
    migrationLastCreatedAt,
    hasProblemsTypeColumn,
    hasContestsTable,
    legacyProblemCount,
    legacyProblemSamples,
    contestCount,
    contestSamples,
    contestProblemCount,
    contestParticipantCount,
    contestSubmissionCount,
    domainCount,
    legacyColumns,
  }, now());
}

/** 列/表可能不存在：失败返回 null 而不是让整个预检挂掉。 */
async function safeCount(
  query: PreflightDeps["query"],
  sql: string,
): Promise<number | null> {
  try {
    const rows = await query(sql);
    return asNumber(rows[0]?.c);
  } catch {
    return null;
  }
}

/**
 * 生产查询实现：单连接只读事务。
 *
 * 刻意使用独立 postgres.js 连接而不是应用连接池：
 * - 只读事务必须绑定在同一条连接上（`BEGIN` / `SET TRANSACTION` / `SELECT`），
 *   池化连接会把这些语句分派到不同会话，`READ ONLY` 就失效了；
 * - `SET TRANSACTION READ ONLY` 是硬约束——即使脚本被改成写语句，PG 也会拒绝。
 *
 * 连接在 `closePreflightConnection()` 里统一关闭（回滚 + end），不留悬挂事务。
 */
let preflightClient: postgres.Sql | null = null;

function defaultQuery(): PreflightDeps["query"] {
  let started: Promise<postgres.Sql> | null = null;
  const start = async (): Promise<postgres.Sql> => {
    const databaseUrl = Deno.env.get("DATABASE_URL");
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL 未设置：请用 --env-file 指定运维环境的连接串",
      );
    }
    const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    await client.unsafe("BEGIN");
    await client.unsafe("SET TRANSACTION READ ONLY");
    preflightClient = client;
    return client;
  };
  return async (sql: string): Promise<Row[]> => {
    started ??= start();
    const client = await started;
    const rows = await client.unsafe(sql);
    return rows as unknown as Row[];
  };
}

/** 关闭只读事务与连接（成功或失败都要回滚，绝不留悬挂事务）。 */
export async function closePreflightConnection(): Promise<void> {
  const client = preflightClient;
  preflightClient = null;
  if (!client) return;
  try {
    await client.unsafe("ROLLBACK");
  } catch {
    // 连接已断开时无需回滚
  }
  try {
    await client.end({ timeout: 5 });
  } catch {
    // 关闭失败不掩盖真实错误
  }
}

/** 解析 CLI 参数；未知参数直接失败，避免拼错后被静默忽略。 */
export function parseArgs(args: string[]): {
  json?: string;
  csv?: string;
  pretty: boolean;
} {
  const options: { json?: string; csv?: string; pretty: boolean } = {
    pretty: false,
  };
  const takePath = (flag: string): string => {
    const value = args.shift();
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} 需要一个输出路径`);
    }
    return value;
  };
  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--json") options.json = takePath(arg);
    else if (arg === "--csv") options.csv = takePath(arg);
    else if (arg === "--pretty") options.pretty = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

if (import.meta.main) {
  const options = parseArgs(Deno.args);
  let report: PreflightReport;
  try {
    report = await runPreflight();
  } catch (error) {
    console.error(
      "预检失败：" + (error instanceof Error ? error.message : String(error)),
    );
    await closePreflightConnection();
    Deno.exit(1);
  }
  await closePreflightConnection();

  const json = JSON.stringify(report, null, options.pretty ? 2 : 0);
  if (options.json) {
    await Deno.writeTextFile(options.json, json + "\n");
    console.log(`预检报告已写入 ${options.json}`);
  }
  if (options.csv) {
    await Deno.writeTextFile(options.csv, renderPreflightCsv(report));
    console.log(`预检 CSV 已写入 ${options.csv}`);
  }
  if (!options.json && !options.csv) console.log(json);

  console.log(
    `迁移已应用 ${report.migration.applied} 条` +
      (report.migration.last_created_at
        ? `，最后一条 ${report.migration.last_created_at}`
        : ""),
  );
  if (report.blockers.length === 0) {
    console.log("预检结论：未命中 0116 的阻塞条件。");
  } else {
    console.error("预检结论：命中阻塞条件，0116 迁移会中止——");
    for (const blocker of report.blockers) {
      console.error(
        `  - ${blocker.code}（${blocker.count} 条）：${blocker.detail}`,
      );
      if (blocker.samples.length > 0) {
        console.error(`    样例：${blocker.samples.join("；")}`);
      }
    }
    console.error(
      "处理方向：确认这些数据的业务归属与授权处理方案后，再执行升级；" +
        "本轮 0.11 RC 只支持新装，不提供删除比赛/题目或绕过 0116 的 SQL。",
    );
  }
  Deno.exit(preflightExitCode(report));
}
