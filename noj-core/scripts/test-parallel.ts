/**
 * 并行分片测试编排（本地 + CI 单机多核加速）。
 *
 * 背景：noj-core 的测试共享同一个 PostgreSQL 实例，resetDbForTest() 的
 * TRUNCATE 在并发下会死锁（CI 曾见 Process 494 vs 495 互锁），因此
 * `deno test --parallel` 不可直接用。本脚本把测试按目录分为互不重叠的
 * 分片，每个分片通过 TEST_SCHEMA（见 src/db/connection.ts 的 search_path
 * 隔离）独占一个 PG schema，进程级并行互不干扰。
 *
 * 用法：
 *   deno task test:parallel            # 并行跑全部分片（需 DATABASE_URL）
 *   deno task test:parallel -- --dry-run   # 仅打印将要执行的命令
 *
 * 分片（目录集合与 .github/workflows/ci.yml 的 core-test-db 一致；unit 分片
 * 多带 tests/00_migrate_test.ts——本脚本所有分片都走真实 PG + TEST_SCHEMA
 * 隔离，需要 00_migrate_test 在每个分片 schema 内执行迁移；而 CI 的
 * core-test-unit 是 PGlite 内存模式（resetDbForTest 自动建表），无需迁移）：
 *   - unit：lib / middleware / types / data / app（schema=test_unit）
 *   - db：  services / routes / mq / db / 迁移 / 种子（schema=test_db）
 *
 * 每个分片都带 tests/00_migrate_test.ts（字母序最先）：PG 模式下它会
 * 在当前 schema 执行文件迁移 + root/rbac/judge_images 种子，保证各组
 * schema 独立可用。
 */
import postgres from "postgres";

const DRY_RUN = Deno.args.includes("--dry-run");

// ── 分片配置 ────────────────────────────────────
const SHARDS = [
  {
    name: "unit",
    schema: "test_unit",
    dirs: [
      "tests/00_migrate_test.ts",
      "tests/lib",
      "tests/middleware",
      "tests/types",
      "tests/data",
      "tests/app.test.ts",
    ],
  },
  {
    name: "db",
    schema: "test_db",
    dirs: [
      "tests/00_migrate_test.ts",
      "tests/services",
      "tests/routes",
      "tests/mq",
      "tests/db",
      "tests/seed_bootstrap_admin_test.ts",
    ],
  },
];

const databaseUrl = Deno.env.get("DATABASE_URL");
if (!databaseUrl) {
  console.error(
    "需要 DATABASE_URL（deno task test:parallel 已带 --env-file=.env）",
  );
  Deno.exit(1);
}

// ── 1. 预建分片 schema ──────────────────────────
if (!DRY_RUN) {
  const admin = postgres(databaseUrl, { max: 1 });
  for (const shard of SHARDS) {
    await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS "${shard.schema}"`);
    console.log(`schema ${shard.schema} 就绪`);
  }
  await admin.end();
}

// ── 2. 并行执行各分片 ───────────────────────────
const children = SHARDS.map((shard) => {
  const args = [
    "test",
    "-A",
    "--no-check",
    "--env-file=.env",
    ...shard.dirs,
  ];
  const cmd = `TEST_SCHEMA=${shard.schema} deno ${args.join(" ")}`;
  console.log(`\n[shard ${shard.name}] ${cmd}\n`);
  if (DRY_RUN) return null;

  const env = { ...Deno.env.toObject(), TEST_SCHEMA: shard.schema };
  return {
    name: shard.name,
    proc: new Deno.Command("deno", {
      args,
      env,
      stdout: "inherit",
      stderr: "inherit",
    }).spawn(),
  };
});

if (DRY_RUN) Deno.exit(0);

// ── 3. 汇总退出码 ───────────────────────────────
let failed = false;
for (const child of children) {
  if (!child) continue;
  const status = await child.proc.status;
  if (!status.success) {
    failed = true;
    console.error(`[shard ${child.name}] 失败 (exit=${status.code})`);
  } else {
    console.log(`[shard ${child.name}] 通过`);
  }
}
if (failed) {
  console.error("存在失败分片");
  Deno.exit(1);
}
console.log("全部测试分片通过 ✅");
