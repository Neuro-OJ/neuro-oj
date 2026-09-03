/**
 * 并行分片测试编排（本地 + CI 单机多核加速）。
 *
 * 背景：noj-core 的测试共享同一个 PostgreSQL 实例，resetDbForTest() 的
 * TRUNCATE 在并发下会死锁（CI 曾见 Process 494 vs 495 互锁），因此
 * `deno test --parallel` 不可直接用。本脚本把测试按目录分为互不重叠的
 * 分片，每个分片通过 TEST_SCHEMA（见 src/db/connection.ts 的 search_path
 * 隔离）独占一个 PG schema，进程级并行互不干扰。
 *
 * 稳定性隔离：
 * - PG：每个分片独立 TEST_SCHEMA；
 * - Redis：每个分片使用独立 Redis DB，并在启动前 FLUSHDB；
 * - 本地存储：每个分片使用独立 SUPPORT_PACKAGE_DIR；
 * - S3：每个分片使用独立 S3_BUCKET（若 STORAGE_PROVIDER=s3）。
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
 */
import postgres from "postgres";
import IORedis from "ioredis";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const DRY_RUN = Deno.args.includes("--dry-run");

// ── 分片配置 ────────────────────────────────────
const SHARDS = [
  {
    name: "unit",
    schema: "test_unit",
    redisDb: 1,
    storageDir: "",
    s3Bucket: "noj-test-unit",
    dirs: [
      "tests/00_migrate_test.ts",
      "tests/lib",
      "tests/middleware",
      "tests/types",
      "tests/shared",
      "src/domains/identity/tests/lib",
      "src/domains/catalog/tests/lib",
      "src/domains/identity/tests/middleware",
      "src/domains/query/tests/middleware",
      "src/domains/system/tests/middleware",
      "src/domains/catalog/tests/types",
      "src/domains/contest/tests/types",
      "src/domains/submission/tests/types",
      "tests/data",
      "tests/app.test.ts",
    ],
  },
  {
    name: "db",
    schema: "test_db",
    redisDb: 2,
    storageDir: ".test-storage/db",
    s3Bucket: "noj-test-db",
    dirs: [
      "tests/00_migrate_test.ts",
      "tests/services",
      "tests/routes",
      "tests/mq",
      "tests/db",
      "tests/seed_bootstrap_admin_test.ts",
      "src/domains/identity/tests/routes",
      "src/domains/identity/tests/services",
      "src/domains/catalog/tests/routes",
      "src/domains/catalog/tests/services",
      "src/domains/submission/tests/routes",
      "src/domains/submission/tests/services",
      "src/domains/submission/tests/mq",
      "src/domains/query/tests/routes",
      "src/domains/query/tests/services",
      "src/domains/contest/tests/routes",
      "src/domains/contest/tests/services",
      "src/domains/community/tests/routes",
      "src/domains/community/tests/services",
      "src/domains/messaging/tests/routes",
      "src/domains/messaging/tests/services",
      "src/domains/objective/tests/routes",
      "src/domains/objective/tests/services",
      "src/domains/system/tests/routes",
      "src/domains/system/tests/services",
      "src/domains/gateway/tests/services",
      "src/domains/content-review/tests/services",
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

const baseRedisUrl = Deno.env.get("REDIS_URL") ?? "redis://127.0.0.1:6379/";

/** 把 Redis URL 的 DB 编号替换/追加为目标 DB */
function withRedisDb(url: string, db: number): string {
  const trimmed = url.endsWith("/") ? url.slice(0, -1) : url;
  const match = trimmed.match(/^(.*\/)(\d+)$/);
  if (match) return `${match[1]}${db}`;
  return `${trimmed}/${db}`;
}

/** 清空指定 Redis DB */
async function flushRedisDb(redisUrl: string): Promise<void> {
  // @ts-ignore - ioredis 构造函数类型在 Deno 中解析受限
  const redis = new IORedis(redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    await redis.flushdb();
    console.log(`Redis DB 已清空: ${redisUrl}`);
  } finally {
    await redis.quit().catch(() => {});
  }
}

/** 确保 S3 bucket 存在（仅 STORAGE_PROVIDER=s3 时使用） */
async function ensureS3Bucket(bucket: string): Promise<void> {
  if (Deno.env.get("STORAGE_PROVIDER") !== "s3") return;
  const endpoint = Deno.env.get("S3_ENDPOINT");
  const accessKeyId = Deno.env.get("S3_ACCESS_KEY");
  const secretAccessKey = Deno.env.get("S3_SECRET_KEY");
  if (!endpoint || !accessKeyId || !secretAccessKey) return;

  const client = new S3Client({
    endpoint,
    region: Deno.env.get("S3_REGION") || "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`S3 bucket 已创建: ${bucket}`);
  } finally {
    client.destroy();
  }
}

// ── 1. 预建分片 schema + 清理外部状态 ───────────
if (!DRY_RUN) {
  const admin = postgres(databaseUrl, { max: 1 });
  for (const shard of SHARDS) {
    await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS "${shard.schema}"`);
    console.log(`schema ${shard.schema} 就绪`);

    await flushRedisDb(withRedisDb(baseRedisUrl, shard.redisDb));

    // 本地存储目录：仅在显式指定时清空后重建
    if (shard.storageDir) {
      await Deno.remove(shard.storageDir, { recursive: true }).catch(() => {});
      await Deno.mkdir(shard.storageDir, { recursive: true });
      console.log(`storage ${shard.storageDir} 就绪`);
    }

    // S3 模式：确保分片独立 bucket 存在
    await ensureS3Bucket(shard.s3Bucket);
  }
  await admin.end();
}

// ── 2. 并行执行各分片 ───────────────────────────
const children = SHARDS.map((shard) => {
  const redisUrl = withRedisDb(baseRedisUrl, shard.redisDb);
  const args = [
    "test",
    "-A",
    "--no-check",
    "--env-file=.env",
    "--preload=tests/preload.ts",
    ...shard.dirs,
  ];
  const cmd = `TEST_SCHEMA=${shard.schema} REDIS_URL=${redisUrl} deno ${
    args.join(" ")
  }`;
  console.log(`\n[shard ${shard.name}] ${cmd}\n`);
  if (DRY_RUN) return null;

  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    TEST_SCHEMA: shard.schema,
    REDIS_URL: redisUrl,
    // 强制本地存储：避免 S3 内容寻址语义差异导致 avatar 等测试 flaky
    STORAGE_PROVIDER: "local",
    S3_BUCKET: shard.s3Bucket,
    BCRYPT_SALT_ROUNDS: Deno.env.get("BCRYPT_SALT_ROUNDS") ?? "4",
  };
  if (shard.storageDir) {
    env.SUPPORT_PACKAGE_DIR = shard.storageDir;
  }
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
