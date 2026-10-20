/** Gateway 显式迁移计划与 HTTP 启动只读兼容检查的纯逻辑测试。 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  assertMigrationsCompatible,
  compareGatewayMigrationLedger,
  GatewaySchemaCompatibilityError,
  readGatewayMigrationPlan,
  runMigrations,
} from "../src/db/migrate.ts";
import { createDb } from "../src/db.ts";
import { gatewayTestDatabaseUrl as migrationTestDatabaseUrl } from "./integration-env.ts";

async function makeAssets(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await Deno.makeTempDir({ prefix: "noj-gateway-migrations-" });
  await Deno.mkdir(`${dir}/meta`);
  await Deno.writeTextFile(
    `${dir}/meta/_journal.json`,
    JSON.stringify({
      entries: [{
        idx: 0,
        when: 2026102000000,
        tag: "20261020000000_first",
      }],
    }),
  );
  await Deno.writeTextFile(
    `${dir}/20261020000000_first.sql`,
    "CREATE TABLE gateway_first (id integer);\n",
  );
  // 这些文件代表未被旧 journal 登记、但已由历史迁移流程应用的固定基线。
  // 测试直接复制仓库资产，确保历史 hash manifest 也参与校验。
  for (
    const name of [
      "0000_baseline.sql",
      "0001_llm_usage_billed_tokens.sql",
      "0002_remove_byok_created_by.sql",
      "0003_remove_provider_model.sql",
      "0004_llm_usage_attempt_scope.sql",
      "0005_domain_ownership.sql",
      "0005_provider_rate_limits.sql",
    ]
  ) {
    await Deno.copyFile(
      new URL(`../drizzle/${name}`, import.meta.url),
      `${dir}/${name}`,
    );
  }
  return { dir, cleanup: () => Deno.remove(dir, { recursive: true }) };
}

Deno.test("gateway migration plan: journal 与历史 allowlist 合并为稳定计划", async () => {
  const assets = await makeAssets();
  try {
    const plan = await readGatewayMigrationPlan(assets.dir);
    assertEquals(plan.map((entry) => entry.name), [
      "0000_baseline.sql",
      "0001_llm_usage_billed_tokens.sql",
      "0002_remove_byok_created_by.sql",
      "0003_remove_provider_model.sql",
      "0004_llm_usage_attempt_scope.sql",
      "0005_domain_ownership.sql",
      "0005_provider_rate_limits.sql",
      "20261020000000_first.sql",
    ]);
    assertEquals(plan[7]?.createdAt, "2026102000000");
    assertEquals(plan[0]?.createdAt, "1000000000000");
    assertEquals(plan[0]?.hash.length, 64);
    assertEquals(plan[1]?.hash.length, 64);

    const actual = plan.map((entry, index) => ({
      id: String(index + 1),
      name: entry.name,
      hash: entry.hash,
      createdAt: entry.createdAt,
    }));
    assertEquals(compareGatewayMigrationLedger(plan, actual), null);
  } finally {
    await assets.cleanup();
  }
});

Deno.test("gateway migration plan: 当前 journal 按 idx 顺序而非文件名字典序排列", async () => {
  const assets = await Deno.makeTempDir({
    prefix: "noj-gateway-migrations-order-",
  });
  try {
    await Deno.mkdir(`${assets}/meta`);
    await Deno.writeTextFile(
      `${assets}/meta/_journal.json`,
      JSON.stringify({
        entries: [
          { idx: 0, when: 200, tag: "zeta" },
          { idx: 1, when: 100, tag: "alpha" },
        ],
      }),
    );
    await Deno.writeTextFile(`${assets}/zeta.sql`, "SELECT 1;\n");
    await Deno.writeTextFile(`${assets}/alpha.sql`, "SELECT 2;\n");
    for (
      const name of [
        "0000_baseline.sql",
        "0001_llm_usage_billed_tokens.sql",
        "0002_remove_byok_created_by.sql",
        "0003_remove_provider_model.sql",
        "0004_llm_usage_attempt_scope.sql",
        "0005_domain_ownership.sql",
        "0005_provider_rate_limits.sql",
      ]
    ) {
      await Deno.copyFile(
        new URL(`../drizzle/${name}`, import.meta.url),
        `${assets}/${name}`,
      );
    }

    const plan = await readGatewayMigrationPlan(assets);
    assertEquals(plan.map((entry) => entry.name), [
      "0000_baseline.sql",
      "0001_llm_usage_billed_tokens.sql",
      "0002_remove_byok_created_by.sql",
      "0003_remove_provider_model.sql",
      "0004_llm_usage_attempt_scope.sql",
      "0005_domain_ownership.sql",
      "0005_provider_rate_limits.sql",
      "zeta.sql",
      "alpha.sql",
    ]);
    assertEquals(plan.slice(-2).map((entry) => entry.createdAt), [
      "200",
      "100",
    ]);
  } finally {
    await Deno.remove(assets, { recursive: true });
  }
});

Deno.test("gateway migration plan: 未登记 SQL、非法 journal 条目拒绝发布集", async () => {
  const assets = await makeAssets();
  try {
    await Deno.writeTextFile(`${assets.dir}/unexpected.sql`, "SELECT 2;\n");
    await assertRejects(
      () => readGatewayMigrationPlan(assets.dir),
      GatewaySchemaCompatibilityError,
      "未登记 SQL",
    );
    await Deno.remove(`${assets.dir}/unexpected.sql`);

    await Deno.writeTextFile(
      `${assets.dir}/meta/_journal.json`,
      JSON.stringify({ entries: [null] }),
    );
    await assertRejects(
      () => readGatewayMigrationPlan(assets.dir),
      GatewaySchemaCompatibilityError,
      "非法",
    );

    await Deno.writeTextFile(
      `${assets.dir}/meta/_journal.json`,
      JSON.stringify({
        entries: [{ idx: 0, when: 1, tag: "../escape" }],
      }),
    );
    await assertRejects(
      () => readGatewayMigrationPlan(assets.dir),
      GatewaySchemaCompatibilityError,
      "非法",
    );

    await Deno.writeTextFile(
      `${assets.dir}/meta/_journal.json`,
      JSON.stringify({
        entries: [
          { idx: 1, when: 1, tag: "20261020000000_first" },
          { idx: 0, when: 2, tag: "20261020000001_second" },
        ],
      }),
    );
    await Deno.writeTextFile(
      `${assets.dir}/20261020000001_second.sql`,
      "SELECT 3;\n",
    );
    await assertRejects(
      () => readGatewayMigrationPlan(assets.dir),
      GatewaySchemaCompatibilityError,
      "乱序",
    );

    await Deno.writeTextFile(
      `${assets.dir}/meta/_journal.json`,
      JSON.stringify({
        entries: [{
          idx: 0,
          when: Number.MAX_SAFE_INTEGER + 1,
          tag: "20261020000000_first",
        }],
      }),
    );
    await assertRejects(
      () => readGatewayMigrationPlan(assets.dir),
      GatewaySchemaCompatibilityError,
      "非法",
    );
  } finally {
    await assets.cleanup();
  }
});

Deno.test("gateway migration plan: 历史 SQL 缺失或 hash 漂移拒绝发布集", async () => {
  const assets = await makeAssets();
  try {
    await Deno.remove(`${assets.dir}/0004_llm_usage_attempt_scope.sql`);
    await assertRejects(
      () => readGatewayMigrationPlan(assets.dir),
      GatewaySchemaCompatibilityError,
      "缺少历史 SQL",
    );
  } finally {
    await assets.cleanup();
  }

  const drifted = await makeAssets();
  try {
    await Deno.writeTextFile(
      `${drifted.dir}/0000_baseline.sql`,
      "SELECT 1;\n",
    );
    await assertRejects(
      () => readGatewayMigrationPlan(drifted.dir),
      GatewaySchemaCompatibilityError,
      "hash 漂移",
    );
  } finally {
    await drifted.cleanup();
  }
});

Deno.test("gateway migration ledger: 数量、名称、hash、timestamp 任一漂移均可诊断", () => {
  const expected = [{
    name: "0000_baseline.sql",
    content: "",
    hash: "hash",
    createdAt: "100",
  }];
  const mismatch = compareGatewayMigrationLedger(expected, [{
    id: "1",
    name: "0000_baseline.sql",
    hash: "other",
    createdAt: "100",
  }]);
  assertEquals(mismatch?.includes("0000_baseline.sql"), true);
});

Deno.test({
  name: "gateway migration: advisory lock 超时不执行 DDL 且不误解锁",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const admin = createDb(migrationTestDatabaseUrl!);
    const schema = "gw_migration_lock_" +
      crypto.randomUUID().replaceAll("-", "");
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const databaseUrl = new URL(migrationTestDatabaseUrl!);
    databaseUrl.searchParams.set("options", "-csearch_path=" + schema);
    const holder = createDb(databaseUrl.toString());
    try {
      await holder`SELECT pg_advisory_lock(184789, 1)`;
      await assertRejects(
        () =>
          runMigrations(databaseUrl.toString(), { timeoutMs: 100, pollMs: 10 }),
        GatewaySchemaCompatibilityError,
        "超时",
      );
      const [ledger] = await admin<{ name: string | null }[]>`
        SELECT to_regclass(${schema + ".llm_schema_migrations"}) AS name
      `;
      assertEquals(ledger?.name, null);
      // runMigrations 未拿到锁时不能尝试 unlock；持有者仍能正常释放自己的锁。
      const [unlocked] = await holder<{ unlocked: boolean }[]>`
        SELECT pg_advisory_unlock(184789, 1) AS unlocked
      `;
      assertEquals(unlocked?.unlocked, true);
    } finally {
      await holder.end();
      await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
});

Deno.test({
  name:
    "gateway migration: 十条迁移 ledger 按 numeric id 通过 HTTP 启动兼容检查",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const admin = createDb(migrationTestDatabaseUrl!);
    const schema = "gw_migration_order_" +
      crypto.randomUUID().replaceAll("-", "");
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const databaseUrl = new URL(migrationTestDatabaseUrl!);
    databaseUrl.searchParams.set("options", "-csearch_path=" + schema);
    const db = createDb(databaseUrl.toString());
    try {
      await runMigrations(databaseUrl.toString());
      await assertMigrationsCompatible(databaseUrl.toString());

      const rows = await db<{ id: number; name: string }[]>`
        SELECT id, name FROM llm_schema_migrations ORDER BY id ASC
      `;
      const plan = await readGatewayMigrationPlan();
      assertEquals(rows.length, 10);
      assertEquals(
        rows.map((row) => row.name),
        plan.map((entry) => entry.name),
      );
      assertEquals(rows.map((row) => row.id), [
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
      ]);
    } finally {
      await db.end();
      await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
});
