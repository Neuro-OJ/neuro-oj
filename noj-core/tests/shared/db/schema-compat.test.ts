/**
 * HTTP 启动期 schema 兼容检查：只验证打包迁移资产与 ledger 的严格比较，
 * 不启动服务，也不执行数据库 DDL。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  type ActualMigration,
  assertSchemaCompatible,
  compareSchemaLedgers,
  type ExpectedMigration,
  readExpectedMigrations,
  SchemaCompatibilityError,
} from "../../../src/shared/db/schema-compat.ts";

async function makeMigrationAssets(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
  entries: ExpectedMigration[];
}> {
  const dir = await Deno.makeTempDir({ prefix: "noj-schema-compat-" });
  await Deno.mkdir(`${dir}/meta`);
  const files = [
    { idx: 0, when: 100, tag: "0000_first", content: "CREATE TABLE first;\n" },
    {
      idx: 2,
      when: 200,
      tag: "0002_second",
      content: "CREATE TABLE second;\n",
    },
  ];
  await Deno.writeTextFile(
    `${dir}/meta/_journal.json`,
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: files.map(({ idx, when, tag }) => ({
        idx,
        version: "7",
        when,
        tag,
        breakpoints: true,
      })),
    }),
  );
  const entries: ExpectedMigration[] = [];
  for (const file of files) {
    await Deno.writeTextFile(`${dir}/${file.tag}.sql`, file.content);
    const hashBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(file.content),
    );
    entries.push({
      tag: file.tag,
      hash: [...new Uint8Array(hashBytes)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      createdAt: String(file.when),
    });
  }
  return {
    dir,
    entries,
    cleanup: () => Deno.remove(dir, { recursive: true }),
  };
}

Deno.test("schema compat: ledger 完全匹配时通过且只执行注入的查询", async () => {
  const assets = await makeMigrationAssets();
  let queryCount = 0;
  try {
    const actual: ActualMigration[] = assets.entries.map((entry, index) => ({
      id: String(index + 1),
      hash: entry.hash,
      createdAt: entry.createdAt,
    }));
    const result = await assertSchemaCompatible({
      migrationsDir: assets.dir,
      deps: {
        queryLedger: () => {
          queryCount++;
          return Promise.resolve(actual);
        },
      },
    });
    assertEquals(result.expected, assets.entries);
    assertEquals(result.actual, actual);
    assertEquals(queryCount, 1);
  } finally {
    await assets.cleanup();
  }
});

Deno.test("schema compat: ledger 缺失、多出、hash 或 timestamp 漂移均拒绝", async () => {
  const assets = await makeMigrationAssets();
  try {
    const cases: ActualMigration[][] = [
      [],
      [
        ...assets.entries.map((entry, index) => ({
          id: String(index + 1),
          hash: entry.hash,
          createdAt: entry.createdAt,
        })),
        { id: "3", hash: "extra", createdAt: "300" },
      ],
      assets.entries.map((entry, index) => ({
        id: String(index + 1),
        hash: index === 0 ? "drifted" : entry.hash,
        createdAt: entry.createdAt,
      })),
      assets.entries.map((entry, index) => ({
        id: String(index + 1),
        hash: entry.hash,
        createdAt: index === 1 ? "201" : entry.createdAt,
      })),
    ];
    for (const actual of cases) {
      await assertRejects(
        () =>
          assertSchemaCompatible({
            migrationsDir: assets.dir,
            deps: { queryLedger: () => Promise.resolve(actual) },
          }),
        SchemaCompatibilityError,
      );
    }
  } finally {
    await assets.cleanup();
  }
});

Deno.test("schema compat: journal 与 SQL 差集及 idx 顺序均拒绝", async () => {
  const assets = await makeMigrationAssets();
  try {
    await Deno.writeTextFile(`${assets.dir}/unregistered.sql`, "SELECT 1;\n");
    await assertRejects(
      () => readExpectedMigrations(assets.dir),
      SchemaCompatibilityError,
      "未登记 SQL",
    );

    await Deno.remove(`${assets.dir}/unregistered.sql`);
    await Deno.writeTextFile(
      `${assets.dir}/meta/_journal.json`,
      JSON.stringify({
        entries: [
          { idx: 2, when: 100, tag: "0000_first" },
          { idx: 1, when: 200, tag: "0002_second" },
        ],
      }),
    );
    await assertRejects(
      () => readExpectedMigrations(assets.dir),
      SchemaCompatibilityError,
      "idx 未严格递增",
    );

    await Deno.writeTextFile(
      `${assets.dir}/meta/_journal.json`,
      JSON.stringify({
        entries: [{ idx: 0, when: 100, tag: "../escape" }],
      }),
    );
    await assertRejects(
      () => readExpectedMigrations(assets.dir),
      SchemaCompatibilityError,
      "非法 tag/idx",
    );

    await Deno.writeTextFile(
      `${assets.dir}/meta/_journal.json`,
      JSON.stringify({
        entries: [{
          idx: 0,
          when: Number.MAX_SAFE_INTEGER + 1,
          tag: "0000_first",
        }],
      }),
    );
    await assertRejects(
      () => readExpectedMigrations(assets.dir),
      SchemaCompatibilityError,
      "非法条目",
    );
  } finally {
    await assets.cleanup();
  }
});

Deno.test("schema compat: SQL 缺失时拒绝读取发布集", async () => {
  const assets = await makeMigrationAssets();
  try {
    await Deno.remove(`${assets.dir}/0002_second.sql`);
    await assertRejects(
      () => readExpectedMigrations(assets.dir),
      SchemaCompatibilityError,
      "缺少 SQL 文件",
    );
  } finally {
    await assets.cleanup();
  }
});

Deno.test("schema compat: 纯 ledger 比较返回可诊断差异", () => {
  const expected: ExpectedMigration[] = [{
    tag: "0000_first",
    hash: "hash",
    createdAt: "100",
  }];
  const actual: ActualMigration[] = [{
    id: "1",
    hash: "other",
    createdAt: "100",
  }];
  const mismatch = compareSchemaLedgers(expected, actual);
  assert(mismatch?.includes("0000_first"));
});
