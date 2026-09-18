/**
 * 快照链门禁的自测。
 *
 * 门禁本身也必须被测试——否则它可能"永远通过"（本仓库 2026-09-12 评审的核心教训）。
 * 本文件用**临时目录**构造快照/迁移样本，不触碰真实 drizzle 目录。
 *
 * 2026-09-15 补强（评审：自检只断言 `listSnapshots(emptyDir).length === 0`、
 * 从不调用 `checkSnapshotChain()`，删掉 checker 里的空目录守卫也照样绿）：
 * - 空目录用例改为**断言 `checkSnapshotChain()` 本身报错**；
 * - 新增**丢列 / 丢表 / 丢索引 / 丢约束**的阳性回归（断言具体 issue kind）；
 * - 新增**合法显式 DROP** 不误报的用例；
 * - 新增"D取白名单不得全局永久生效"的作用域用例。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  canonicalJson,
  checkSnapshotChain,
  codeTableNames,
  columnSignature,
  createdTableNames,
  droppedTableNames,
  dropsBetween,
  indexSignature,
  INTENTIONAL_REMOVALS,
  LEGACY_RENUMBERING_ARTIFACTS,
  listSnapshots,
  parseDropStatements,
  tableNamesOf,
  tableStructuresOf,
} from "./check-migration-snapshot-chain.ts";

/** 构造一个最小 drizzle 快照。 */
function snapshot(tables: Record<string, unknown>): Record<string, unknown> {
  return { version: "7", dialect: "postgresql", tables };
}

/** 构造一张最小表（可覆盖列/索引）。 */
function table(
  columns: Record<string, Record<string, unknown>>,
  indexes: Record<string, Record<string, unknown>> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "t",
    schema: "",
    columns,
    indexes,
    foreignKeys: {},
    compositePrimaryKeys: {},
    uniqueConstraints: {},
    policies: {},
    checkConstraints: {},
    isRLSEnabled: false,
    ...extra,
  };
}

/** 构造一列。 */
function column(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    type: "text",
    primaryKey: false,
    notNull: false,
    ...overrides,
  };
}

/**
 * 在临时目录里搭一套 fixtures：
 * `meta/` 放快照，`drizzle/` 放迁移，`schema/` 放代码表定义。
 * 返回目录句柄与清理函数。
 */
async function makeFixture(options: {
  snapshots: Record<string, Record<string, unknown>>;
  migrations?: Record<string, string>;
  schema?: string;
}): Promise<{
  root: string;
  meta: string;
  drizzle: string;
  schema: string;
  cleanup: () => Promise<void>;
}> {
  const root = await Deno.makeTempDir({ prefix: "snapshot-chain-test-" });
  const meta = `${root}/meta`;
  const drizzle = `${root}/drizzle`;
  const schema = `${root}/schema`;
  await Deno.mkdir(meta);
  await Deno.mkdir(drizzle);
  await Deno.mkdir(schema);

  for (const [name, value] of Object.entries(options.snapshots)) {
    await Deno.writeTextFile(
      `${meta}/${name}`,
      JSON.stringify(value, null, 2),
    );
  }
  for (const [name, value] of Object.entries(options.migrations ?? {})) {
    await Deno.writeTextFile(`${drizzle}/${name}`, value);
  }
  await Deno.writeTextFile(
    `${schema}/tables.ts`,
    options.schema ?? `export const t = pgTable("t", {});\n`,
  );

  return {
    root,
    meta,
    drizzle,
    schema,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

/** 基线迁移：建表。 */
const BASELINE_MIGRATIONS = {
  "0001_init.sql": `CREATE TABLE "t" ("id" text PRIMARY KEY);`,
};

Deno.test("snapshot-chain: tableNamesOf 去掉 schema 前缀", () => {
  const names = tableNamesOf({
    tables: { "public.users": {}, "public.posts": {}, "legacy": {} },
  });
  assertEquals([...names].sort(), ["legacy", "posts", "users"]);
});

Deno.test("snapshot-chain: tableNamesOf 对空/异常结构返回空集合", () => {
  assertEquals(tableNamesOf({}).size, 0);
  assertEquals(tableNamesOf(null).size, 0);
  assertEquals(tableNamesOf({ tables: null }).size, 0);
});

Deno.test("snapshot-chain: canonicalJson 对键序不敏感、对数组顺序敏感", () => {
  assertEquals(
    canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
  );
  assert(
    canonicalJson(["a", "b"]) !== canonicalJson(["b", "a"]),
    "索引列顺序有语义，不得被规范化抹平",
  );
});

Deno.test("snapshot-chain: columnSignature 覆盖 name/type/notNull/primaryKey/default", () => {
  const base = columnSignature(column("x"));
  assert(
    base !== columnSignature(column("x", { type: "integer" })),
    "类型变化必须体现在签名里",
  );
  assert(
    base !== columnSignature(column("x", { notNull: true })),
    "notNull 变化必须体现在签名里",
  );
  assert(
    base !== columnSignature(column("x", { primaryKey: true })),
    "primaryKey 变化必须体现在签名里",
  );
  assert(
    base !== columnSignature(column("x", { default: "0" })),
    "default 变化必须体现在签名里",
  );
  assert(
    base !== columnSignature(column("y")),
    "列名变化必须体现在签名里",
  );
});

Deno.test("snapshot-chain: columnSignature 对对象型 default 的键序稳定", () => {
  const a = columnSignature(column("x", { default: { b: 1, a: 2 } }));
  const b = columnSignature(column("x", { default: { a: 2, b: 1 } }));
  assertEquals(a, b, "对象型 default 的键序不得造成假阳性");
});

Deno.test("snapshot-chain: indexSignature 覆盖列顺序/唯一/where", () => {
  const idx = (over: Record<string, unknown>) => ({
    name: "idx_x",
    columns: [{ expression: "a" }, { expression: "b" }],
    isUnique: false,
    where: null,
    ...over,
  });
  assert(
    indexSignature(idx({})) !== indexSignature(idx({ isUnique: true })),
    "唯一标志必须体现在签名里",
  );
  assert(
    indexSignature(idx({})) !==
      indexSignature(idx({ where: '"t"."deleted_at" IS NULL' })),
    "部分索引 where 必须体现在签名里",
  );
  assert(
    indexSignature(idx({})) !==
      indexSignature(
        idx({ columns: [{ expression: "b" }, { expression: "a" }] }),
      ),
    "索引列顺序必须体现在签名里",
  );
});

Deno.test("snapshot-chain: tableStructuresOf 提取列与索引", () => {
  const structures = tableStructuresOf({
    tables: {
      "public.t": table(
        { id: column("id") },
        { idx_t_id: { name: "idx_t_id", columns: [], isUnique: false } },
      ),
    },
  });
  const t = structures.get("t")!;
  assertEquals([...t.columns.keys()], ["id"]);
  assertEquals([...t.indexes.keys()], ["idx_t_id"]);
});

Deno.test("snapshot-chain: parseDropStatements 解析 DROP TABLE / COLUMN / INDEX / CONSTRAINT", () => {
  const drops = parseDropStatements(
    `DROP TABLE IF EXISTS "categories";\n` +
      `ALTER TABLE "users" DROP COLUMN "role";\n` +
      `DROP INDEX "users_username_unique";\n` +
      `ALTER TABLE "problems" DROP CONSTRAINT "problems_type_check";\n`,
    "0040_x.sql",
  );
  const asSet = new Set(
    drops.map((d) => `${d.action}|${d.table}|${d.target}`),
  );
  assert(asSet.has("drop_table|categories|categories"));
  assert(asSet.has("drop_column|users|role"));
  assert(asSet.has("drop_index|null|users_username_unique"));
  assert(asSet.has("drop_constraint|problems|problems_type_check"));
});

Deno.test("snapshot-chain: parseDropStatements 处理多行单条 ALTER（0007/0054 写法）", () => {
  const sql =
    `ALTER TABLE "contest_problems" ALTER COLUMN "score" SET NOT NULL;\n` +
    `ALTER TABLE "problems"\n  DROP COLUMN "artifact_max_size_mb";`;
  const drops = parseDropStatements(sql, "0099_multiline.sql");
  const columns = drops.filter((d) => d.action === "drop_column");
  assert(
    columns.some((d) =>
      d.table === "problems" && d.target === "artifact_max_size_mb"
    ),
    `多行 ALTER 的 DROP COLUMN 必须能对上目标表，实际 ${JSON.stringify(drops)}`,
  );
});

Deno.test("snapshot-chain: dropsBetween 只保留区间内的 DROP（作用域不复用历史豁免）", () => {
  const drops = parseDropStatements(
    `DROP TABLE "old_one";`,
    "0010_a.sql",
  ).concat(
    parseDropStatements(`DROP TABLE "new_one";`, "0050_b.sql"),
  );
  const scoped = dropsBetween(drops, 49, 50);
  assertEquals(scoped.map((d) => d.target), ["new_one"]);
  // 历史 DROP（0010）不得出现在后续区间
  assertEquals(dropsBetween(drops, 50, 51).length, 0);
});

Deno.test("snapshot-chain: 真实仓库的已创建表解析包含不带引号的早期迁移写法", async () => {
  const created = await createdTableNames();
  assert(created.size > 50, `应解析出大量建表语句，实际 ${created.size}`);
  // 0000_initial.sql 用 `CREATE TABLE IF NOT EXISTS users (`（无引号）
  assert(created.has("users"), "应解析出不带引号的 users 表");
  assert(created.has("search_entries"), "应解析出 search_entries");
});

Deno.test("snapshot-chain: 真实仓库的 DROP TABLE 解析生效", async () => {
  const dropped = await droppedTableNames();
  // 0040_drop_categories_add_tags.sql 显式删除 categories
  assert(dropped.has("categories"), "应解析出被显式 DROP 的 categories");
});

Deno.test("snapshot-chain: 真实仓库的代码表与最新快照一致（本次修复的核心不变量）", async () => {
  const codeTables = await codeTableNames();
  assert(
    codeTables.size > 50,
    `应解析出大量 pgTable 定义，实际 ${codeTables.size}`,
  );

  const files = await listSnapshots();
  const latest = JSON.parse(await Deno.readTextFile(files.at(-1)!));
  const snapshotTables = tableNamesOf(latest);

  const missing = [...codeTables].filter((t) => !snapshotTables.has(t));
  assertEquals(
    missing,
    [],
    `以下表在代码中定义但不在最新快照中：${missing.join(",")}。` +
      `这会让下一次 db:generate 生成重复的 CREATE TABLE`,
  );
});

Deno.test("snapshot-chain: 门禁在当前仓库状态通过", async () => {
  const issues = await checkSnapshotChain();
  assertEquals(issues, []);
});

Deno.test("snapshot-chain: 自检——快照目录为空时 checkSnapshotChain 判定失败（而非静默通过）", async () => {
  const fixture = await makeFixture({ snapshots: {} });
  try {
    const issues = await checkSnapshotChain(
      fixture.meta,
      fixture.drizzle,
      fixture.schema,
    );
    assert(issues.length > 0, "空快照目录必须判失败，不能静默通过");
    assertEquals(issues[0]!.kind, "code_snapshot_mismatch");
    assert(
      issues[0]!.detail.includes("没有任何快照文件"),
      `应说明"失去检查对象"，实际：${issues[0]!.detail}`,
    );
    // 同时保留 listSnapshots 的原子行为断言
    assertEquals((await listSnapshots(fixture.meta)).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("snapshot-chain: 阳性回归——故意丢列必须被检出（missing_column_in_later_snapshot）", async () => {
  const fixture = await makeFixture({
    snapshots: {
      "0001_snapshot.json": snapshot({
        "public.t": table({
          id: column("id", { primaryKey: true }),
          gone: column("gone", { notNull: true, default: "''" }),
        }),
      }),
      // 0002 少了 gone 列，且没有任何 DROP COLUMN 迁移
      "0002_snapshot.json": snapshot({
        "public.t": table({ id: column("id", { primaryKey: true }) }),
      }),
    },
    migrations: BASELINE_MIGRATIONS,
  });
  try {
    const issues = await checkSnapshotChain(
      fixture.meta,
      fixture.drizzle,
      fixture.schema,
    );
    const kinds = issues.map((i) => i.kind);
    assert(
      kinds.includes("missing_column_in_later_snapshot"),
      `丢列必须被检出，实际 kinds=${JSON.stringify(kinds)}`,
    );
    const issue = issues.find((i) =>
      i.kind === "missing_column_in_later_snapshot"
    )!;
    assert(
      issue.detail.includes("t.gone"),
      `报错必须点名具体列，实际：${issue.detail}`,
    );
    assert(
      issue.detail.includes("ADD COLUMN"),
      `报错必须说明后果（db:generate 会 ADD COLUMN），实际：${issue.detail}`,
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("snapshot-chain: 阳性回归——故意丢表必须被检出（missing_in_later_snapshot）", async () => {
  const fixture = await makeFixture({
    snapshots: {
      "0001_snapshot.json": snapshot({
        "public.t": table({ id: column("id") }),
        "public.other": table({ id: column("id") }),
      }),
      "0002_snapshot.json": snapshot({
        "public.t": table({ id: column("id") }),
        // other 消失，且没有 DROP TABLE 迁移
      }),
    },
    migrations: BASELINE_MIGRATIONS,
  });
  try {
    const issues = await checkSnapshotChain(
      fixture.meta,
      fixture.drizzle,
      fixture.schema,
    );
    const kinds = issues.map((i) => i.kind);
    assert(
      kinds.includes("missing_in_later_snapshot"),
      `丢表必须被检出，实际 kinds=${JSON.stringify(kinds)}`,
    );
    assert(
      issues.some((i) =>
        i.kind === "missing_in_later_snapshot" && i.detail.includes("other")
      ),
      `报错必须点名 other，实际：${JSON.stringify(issues)}`,
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("snapshot-chain: 阳性回归——故意丢索引必须被检出（missing_index_in_later_snapshot）", async () => {
  const idx = {
    name: "idx_t_x",
    columns: [{ expression: "x" }],
    isUnique: false,
  };
  const fixture = await makeFixture({
    snapshots: {
      "0001_snapshot.json": snapshot({
        "public.t": table({ id: column("id") }, { idx_t_x: idx }),
      }),
      "0002_snapshot.json": snapshot({
        "public.t": table({ id: column("id") }, {}),
      }),
    },
    migrations: BASELINE_MIGRATIONS,
  });
  try {
    const issues = await checkSnapshotChain(
      fixture.meta,
      fixture.drizzle,
      fixture.schema,
    );
    assert(
      issues.some((i) => i.kind === "missing_index_in_later_snapshot"),
      `丢索引必须被检出，实际 kinds=${
        JSON.stringify(issues.map((i) => i.kind))
      }`,
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("snapshot-chain: 阳性回归——故意丢唯一约束必须被检出", async () => {
  const uq = {
    t_x_unique: { name: "t_x_unique", nullsNotDistinct: false, columns: ["x"] },
  };
  const fixture = await makeFixture({
    snapshots: {
      "0001_snapshot.json": snapshot({
        "public.t": table({ id: column("id") }, {}, { uniqueConstraints: uq }),
      }),
      "0002_snapshot.json": snapshot({
        "public.t": table({ id: column("id") }),
      }),
    },
    migrations: BASELINE_MIGRATIONS,
  });
  try {
    const issues = await checkSnapshotChain(
      fixture.meta,
      fixture.drizzle,
      fixture.schema,
    );
    assert(
      issues.some((i) =>
        i.kind === "missing_unique_constraint_in_later_snapshot"
      ),
      `丢唯一约束必须被检出，实际 kinds=${
        JSON.stringify(issues.map((i) => i.kind))
      }`,
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("snapshot-chain: 合法显式 DROP COLUMN 不触发门禁", async () => {
  const fixture = await makeFixture({
    snapshots: {
      "0001_snapshot.json": snapshot({
        "public.t": table({
          id: column("id", { primaryKey: true }),
          gone: column("gone"),
        }),
      }),
      "0002_snapshot.json": snapshot({
        "public.t": table({ id: column("id", { primaryKey: true }) }),
      }),
    },
    migrations: {
      ...BASELINE_MIGRATIONS,
      // 与丢列同区间的显式 DROP COLUMN
      "0002_drop_gone.sql": `ALTER TABLE "t" DROP COLUMN "gone";`,
    },
  });
  try {
    const issues = await checkSnapshotChain(
      fixture.meta,
      fixture.drizzle,
      fixture.schema,
    );
    assertEquals(
      issues,
      [],
      `显式 DROP COLUMN 属可评审删除，不得报错：${JSON.stringify(issues)}`,
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("snapshot-chain: 合法显式 DROP TABLE / DROP INDEX 不触发门禁", async () => {
  const idx = {
    name: "idx_t_x",
    columns: [{ expression: "x" }],
    isUnique: false,
  };
  const fixture = await makeFixture({
    snapshots: {
      "0001_snapshot.json": snapshot({
        "public.t": table({ id: column("id") }, { idx_t_x: idx }),
        "public.other": table({ id: column("id") }),
      }),
      "0002_snapshot.json": snapshot({
        "public.t": table({ id: column("id") }, {}),
      }),
    },
    migrations: {
      "0001_init.sql": `CREATE TABLE "t" ("id" text PRIMARY KEY);\n` +
        `CREATE TABLE "other" ("id" text PRIMARY KEY);`,
      "0002_cleanup.sql": `DROP TABLE "other";\n` +
        `DROP INDEX "idx_t_x";`,
    },
  });
  try {
    const issues = await checkSnapshotChain(
      fixture.meta,
      fixture.drizzle,
      fixture.schema,
    );
    assertEquals(
      issues,
      [],
      `显式 DROP TABLE / DROP INDEX 不得报错：${JSON.stringify(issues)}`,
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("snapshot-chain: DROP 豁免按区间作用域——历史 DROP 不能豁免后续快照的丢列", async () => {
  // 0010 删过 t.gone；t.gone 在 0020 又出现；0030 再次消失（无 DROP）→ 必须报错。
  // 旧实现用全局永久白名单会漏掉这一场景。
  const fixture = await makeFixture({
    snapshots: {
      "0010_snapshot.json": snapshot({
        "public.t": table({ id: column("id") }),
      }),
      "0020_snapshot.json": snapshot({
        "public.t": table({ id: column("id"), gone: column("gone") }),
      }),
      "0030_snapshot.json": snapshot({
        "public.t": table({ id: column("id") }),
      }),
    },
    migrations: {
      "0001_init.sql": `CREATE TABLE "t" ("id" text PRIMARY KEY);`,
      "0010_drop.sql": `ALTER TABLE "t" DROP COLUMN "gone";`,
      "0020_readd.sql": `ALTER TABLE "t" ADD COLUMN "gone" text;`,
    },
  });
  try {
    const issues = await checkSnapshotChain(
      fixture.meta,
      fixture.drizzle,
      fixture.schema,
    );
    assert(
      issues.some((i) =>
        i.kind === "missing_column_in_later_snapshot" &&
        i.detail.includes("t.gone")
      ),
      `0020→0030 的丢列必须被检出（0010 的历史 DROP 不得提供豁免），` +
        `实际：${JSON.stringify(issues)}`,
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("snapshot-chain: 跨多个快照的 DROP 区间仍被认作合法（编号错位容错）", async () => {
  // 0054 的 DROP COLUMN 作用在 0053→0054 快照区间（本仓库真实错位形态）
  const fixture = await makeFixture({
    snapshots: {
      "0053_snapshot.json": snapshot({
        "public.t": table({ id: column("id"), gone: column("gone") }),
      }),
      "0054_snapshot.json": snapshot({
        "public.t": table({ id: column("id") }),
      }),
    },
    migrations: {
      "0001_init.sql": `CREATE TABLE "t" ("id" text PRIMARY KEY);`,
      "0054_drop.sql": `ALTER TABLE "t" DROP COLUMN "gone";`,
    },
  });
  try {
    const issues = await checkSnapshotChain(
      fixture.meta,
      fixture.drizzle,
      fixture.schema,
    );
    assertEquals(
      issues,
      [],
      `同区间显式 DROP 必须被认作合法：${JSON.stringify(issues)}`,
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("snapshot-chain: 自检——快照解析不到列时判定失败（列级摘要不得退化成空壳）", async () => {
  const fixture = await makeFixture({
    snapshots: {
      "0001_snapshot.json": snapshot({ "public.t": table({}) }),
    },
    migrations: BASELINE_MIGRATIONS,
  });
  try {
    const issues = await checkSnapshotChain(
      fixture.meta,
      fixture.drizzle,
      fixture.schema,
    );
    assert(
      issues.some((i) => i.kind === "code_snapshot_mismatch"),
      `解析到 0 列必须判失败，实际：${JSON.stringify(issues)}`,
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("snapshot-chain: INTENTIONAL_REMOVALS 的每一项都写明理由", () => {
  const entries = Object.entries(INTENTIONAL_REMOVALS);
  assert(entries.length > 0, "应有已登记的跨服务移交表");
  for (const [table, reason] of entries) {
    assert(reason.length > 10, `${table} 的理由过短，需说明来源与原因`);
  }
});

Deno.test("snapshot-chain: LEGACY_RENUMBERING_ARTIFACTS 的每一项都写明证据", () => {
  const entries = Object.entries(LEGACY_RENUMBERING_ARTIFACTS);
  for (const [key, reason] of entries) {
    assert(
      /^[a-z0-9_]+\.[a-z0-9_]+$/.test(key),
      `${key} 必须是 表.列 或 表.约束 形式`,
    );
    assert(
      reason.length > 30 && reason.includes("0054"),
      `${key} 的理由必须写明来源迁移与证据，实际：${reason}`,
    );
  }
});
