// deno-lint-ignore-file no-explicit-any -- drizzle snapshot 为外部 JSON 结构，统一按字段取值
/**
 * drizzle 快照链完整性门禁。
 *
 * 背景（2026-09-14 实测发现）：`drizzle/meta/*_snapshot.json` 是 drizzle-kit 生成迁移的
 * **唯一增量基线**。若快照链丢失某张已存在的表（本例：`public.search_entries` 在 0075
 * 快照中存在，自 0076 起消失），下一次 `deno task db:generate` 会把它当作"新表"重新
 * 生成 `CREATE TABLE`——该语句在**空库**上执行成功，因此现有测试（`00_migrate_test.ts`
 * 只跑空库）完全无法发现，但会在**任何存量部署**上以 `relation "xxx" already exists`
 * 失败；而迁移失败会让整批迁移回滚、core 因 `depends_on` 永不启动（全站不可用）。
 *
 * 2026-09-15 升级（评审：门禁只比对「表名集合」）：同一机制对**列/索引**同样成立——
 * 从快照里删掉一列（如 `search_entries.deleted_by_user_ids`）或一个索引，`db:generate`
 * 会生成 `ALTER TABLE ... ADD COLUMN ...` / `CREATE INDEX ...`，而该 DDL 在**已有该列的
 * 存量库**上会以 `column already exists` / `relation already exists` 失败。因此门禁从
 * 「表名集合」升级为**结构化摘要**（表 → 列/索引签名）。
 *
 * 本门禁做三件事：
 * 1. **快照链单调性（表 + 列 + 索引）**：后一个快照不能比前一个少表/列/索引，
 *    删除必须走**同区间内**的显式 DROP 迁移；
 * 2. **快照 vs 代码一致性**：代码里 `pgTable("...")` 定义的表集合必须与最新快照一致，
 *    且最新快照中的表必须都真的被某条迁移创建过（防止"快照有、迁移没有"）；
 * 3. **自检**：解析不到任何表定义时判定失败并退出非零，避免"路径漂移后永远报绿"。
 *
 * 关于"合法删除"的判定口径（重要）：
 * - 历史上本文件使用**全局且永久**的 `droppedTableNames()` 白名单——只要任一历史迁移
 *   出现过 `DROP TABLE foo`，`foo` 此后从任何快照消失都永久免检。这正是丢表事故
 *   （`search_entries`）能长期漏过的原因之一。现已改为**按迁移区间作用域**：某个表/列/
 *   索引在快照 N → N+1 之间消失时，只认 **N 与 N+1 之间那几条迁移**里的显式 DROP；
 *   早于 N 的历史 DROP 不再提供豁免。
 * - 快照编号与迁移编号**不是一一对应**的（本仓库存在"重生成导致编号错位"的历史区间：
 *   0032 的 DROP COLUMN 实际作用在 0031→0032 的快照区间；0054 的加列实际作用在
 *   0053→0054 的快照区间）。因此 DROP 豁免按"迁移编号 ∈ (N, N+1]"的**区间**匹配，
 *   而不是按"迁移文件名 == N+1"精确匹配。
 * - 仍有 3 处历史错位是无法用区间本地性解释的（快照 54→55 的 `problems.submission_mode`、
 *   `artifact_max_size_mb`、`submissions.artifact_storage_url`）：0054 明确 `ADD COLUMN`，
 *   0055 完全没有 DROP，`db:generate` 却在 0055 快照里把它们抹掉了——这正是"新丢列
 *   事故"的原型。为了让门禁能带着历史包上线（否则 CI 立刻红灯），这 3 条登记在
 *   `LEGACY_RENUMBERING_ARTIFACTS`；**新增条目必须附证据**，绝不要为了"变绿"而下调规则。
 */
import { walk } from "jsr:@std/fs@^1/walk";

/** 单条问题描述。 */
export interface SnapshotChainIssue {
  kind:
    | "missing_in_later_snapshot"
    | "missing_column_in_later_snapshot"
    | "missing_index_in_later_snapshot"
    | "missing_unique_constraint_in_later_snapshot"
    | "missing_composite_primary_key_in_later_snapshot"
    | "missing_check_constraint_in_later_snapshot"
    | "missing_foreign_key_in_later_snapshot"
    | "code_snapshot_mismatch"
    | "never_created";
  detail: string;
}

/** 单个实体的结构化签名。 */
export interface EntitySignature {
  name: string;
  /** 稳定序列化后的完整签名（键序无关）。 */
  signature: string;
}

/** 单张表的结构化摘要：列、索引与其余约束段。 */
export interface TableStructure {
  name: string;
  columns: Map<string, EntitySignature>;
  indexes: Map<string, EntitySignature>;
  /** 其余约束段：段名（uniqueConstraints 等）→ 名称 → 签名 */
  constraints: Map<string, Map<string, EntitySignature>>;
}

/**
 * 需要做「只增不减」检查的约束段。
 *
 * 与索引同理：这些对象从快照里静默消失时，`db:generate` 会重新生成
 * `ADD CONSTRAINT` / `CREATE INDEX`，在已有该对象的存量库上失败。
 * 合法性判据与列/索引一致：消失区间内必须有显式 `DROP CONSTRAINT` / `DROP INDEX`。
 */
export const CONSTRAINT_SECTIONS: Record<string, SnapshotChainIssue["kind"]> = {
  uniqueConstraints: "missing_unique_constraint_in_later_snapshot",
  compositePrimaryKeys: "missing_composite_primary_key_in_later_snapshot",
  checkConstraints: "missing_check_constraint_in_later_snapshot",
  foreignKeys: "missing_foreign_key_in_later_snapshot",
};

/** 约束段的展示名（用于中文报错文案）。 */
const CONSTRAINT_SECTION_LABELS: Record<string, string> = {
  uniqueConstraints: "唯一约束",
  compositePrimaryKeys: "复合主键",
  checkConstraints: "CHECK 约束",
  foreignKeys: "外键",
};

const SNAPSHOT_DIR = "noj-core/drizzle/meta";
const MIGRATIONS_DIR = "noj-core/drizzle";
const SCHEMA_DIR = "noj-core/src/shared/db/schema";

/**
 * 键序无关的稳定 JSON 序列化。
 *
 * 必要性：drizzle 快照的 `default` 可能是字符串、数字、布尔，也可能是表达式对象/数组；
 * 对象键序并不保证稳定。若直接 `JSON.stringify`，键序变化会被误判为"列定义变化"
 * （历史上也会被误判为 drop）。此处递归排序对象键（数组保持原序，因为索引列顺序有语义）。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${
    entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(
      ",",
    )
  }}`;
}

/** 去掉 `public.` 之类的 schema 前缀，得到裸表名。 */
export function bareTableName(snapshotKey: string): string {
  return snapshotKey.includes(".")
    ? snapshotKey.split(".").pop()!
    : snapshotKey;
}

/** 读取快照文件中的表名集合（去掉 `public.` 前缀）。 */
export function tableNamesOf(snapshot: any): Set<string> {
  const tables = snapshot?.tables ?? {};
  return new Set(Object.keys(tables).map(bareTableName));
}

/** 单个列的结构化签名：至少覆盖 (name, type, notNull, primaryKey, default)。 */
export function columnSignature(column: any): string {
  return canonicalJson({
    name: column?.name ?? null,
    type: column?.type ?? null,
    notNull: column?.notNull ?? null,
    primaryKey: column?.primaryKey ?? null,
    default: column?.default ?? null,
  });
}

/** 单个索引的结构化签名：名称 + 有序列 + 唯一标志 + 部分索引 `where`。 */
export function indexSignature(index: any): string {
  const columns = Array.isArray(index?.columns) ? index.columns : [];
  return canonicalJson({
    name: index?.name ?? null,
    columns: columns.map((col: any) =>
      typeof col === "object" && col !== null ? col.expression : col
    ),
    isUnique: index?.isUnique ?? false,
    where: index?.where ?? null,
  });
}

/** 把快照降维成 `表名 -> {列签名, 索引签名}` 的结构化摘要。 */
export function tableStructuresOf(
  snapshot: any,
): Map<string, TableStructure> {
  const out = new Map<string, TableStructure>();
  const tables = snapshot?.tables ?? {};
  for (const [key, table] of Object.entries(tables as Record<string, any>)) {
    const columns = new Map<string, EntitySignature>();
    for (
      const [colKey, col] of Object.entries(
        (table?.columns ?? {}) as Record<string, any>,
      )
    ) {
      columns.set(col?.name ?? colKey, {
        name: col?.name ?? colKey,
        signature: columnSignature(col),
      });
    }
    const indexes = new Map<string, EntitySignature>();
    for (
      const [idxKey, idx] of Object.entries(
        (table?.indexes ?? {}) as Record<string, any>,
      )
    ) {
      indexes.set(idx?.name ?? idxKey, {
        name: idx?.name ?? idxKey,
        signature: indexSignature(idx),
      });
    }
    const constraints = new Map<string, Map<string, EntitySignature>>();
    for (const section of Object.keys(CONSTRAINT_SECTIONS)) {
      const entries = new Map<string, EntitySignature>();
      for (
        const [key, value] of Object.entries(
          (table?.[section] ?? {}) as Record<string, any>,
        )
      ) {
        entries.set(value?.name ?? key, {
          name: value?.name ?? key,
          // 约束也做稳定序列化：键序变化不得被误判为"约束变化/消失"
          signature: canonicalJson(value),
        });
      }
      constraints.set(section, entries);
    }
    out.set(bareTableName(key), {
      name: bareTableName(key),
      columns,
      indexes,
      constraints,
    });
  }
  return out;
}

/** 按文件名顺序列出全部快照文件（0000 → 0082）。 */
export async function listSnapshots(dir = SNAPSHOT_DIR): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of walk(dir, { maxDepth: 1, includeDirs: false })) {
    if (/^\d+_snapshot\.json$/.test(entry.name)) files.push(entry.path);
  }
  // 按数字前缀排序，避免字典序把 0010 排在 0009 之前的问题（此处位数一致，仍显式排序）
  return files.sort((a, b) => {
    const na = Number(a.match(/(\d+)_snapshot\.json$/)?.[1] ?? 0);
    const nb = Number(b.match(/(\d+)_snapshot\.json$/)?.[1] ?? 0);
    return na - nb;
  });
}

/** 从代码中的 `pgTable("name"` 提取表名集合。 */
export async function codeTableNames(dir = SCHEMA_DIR): Promise<Set<string>> {
  const names = new Set<string>();
  for await (
    const entry of walk(dir, { maxDepth: 1, includeDirs: false, exts: [".ts"] })
  ) {
    const text = await Deno.readTextFile(entry.path);
    // 兼容 pgTable(\n  "name", 与 pgTable("name",
    for (const match of text.matchAll(/pgTable\(\s*\n?\s*"([a-z0-9_]+)"/g)) {
      names.add(match[1]!);
    }
  }
  return names;
}

/** 从全部迁移 SQL 中提取 `CREATE TABLE [IF NOT EXISTS] "name"` 的表名。 */
export async function createdTableNames(
  dir = MIGRATIONS_DIR,
): Promise<Set<string>> {
  const names = new Set<string>();
  for await (
    const entry of walk(dir, {
      maxDepth: 1,
      includeDirs: false,
      exts: [".sql"],
    })
  ) {
    const text = await Deno.readTextFile(entry.path);
    // 表名可能带引号（"users"）也可能不带（users），schema 前缀可有可无。
    // 早期迁移（0000_initial.sql）使用不带引号的 `CREATE TABLE IF NOT EXISTS users (`，
    // 只匹配带引号形态会产生"表从未被创建"的假阳性。
    for (
      const match of text.matchAll(
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?[a-z_]+"?\.)?"?([a-z0-9_]+)"?\s*\(/gi,
      )
    ) {
      names.add(match[1]!);
    }
  }
  return names;
}

/**
 * 有意从 core 快照中移除的表（**必须附理由**）。
 *
 * 这些是"交接给其他服务管理"的表，移除是有意为之，不属于快照链事故。
 * 新增条目必须写明来源，否则后人无法判断是"有意为之"还是"又一次丢表"。
 * 注意：该登记用于表被**整个**移除的场景；单列/单索引的移除不走这里（走 DROP 迁移）。
 */
export const INTENTIONAL_REMOVALS: Record<string, string> = {
  // 0060_wild_mister_fear.sql 注释：LLM 三表已移交 noj-llm-gateway 管理
  llm_providers:
    "LLM 三表移交 noj-llm-gateway（见 noj-core/drizzle/0060_wild_mister_fear.sql）",
  llm_usage:
    "LLM 三表移交 noj-llm-gateway（见 noj-core/drizzle/0060_wild_mister_fear.sql）",
  llm_quotas:
    "LLM 三表移交 noj-llm-gateway（见 noj-core/drizzle/0060_wild_mister_fear.sql）",
};

/**
 * 历史"快照编号错位"事故的豁免清单，键为 `表.列名` 或 `表.约束名`。
 *
 * 只登记一类情况——**迁移明确创建了该对象（ADD COLUMN / ADD CONSTRAINT），后续某个快照
 * 却把它抹掉，并且区间内没有任何对应的 DROP**。这不是"有意删除"，而是 `db:generate` 与
 * 快照链错位的历史残留（与 `search_entries` 丢表同源）。豁免的存在只是让门禁能带着历史包
 * 上线；**新增条目必须写明证据**，且不得用于掩盖新发生的结构丢失。
 */
export const LEGACY_RENUMBERING_ARTIFACTS: Record<string, string> = {
  "problems.submission_mode":
    "0054_hard_scalphunter.sql 明确 ADD COLUMN；0055 快照把它抹掉且区间内无 DROP COLUMN——属 db:generate 快照错位的历史残留（复核日期：2026-09-15）",
  "problems.artifact_max_size_mb":
    "0054_hard_scalphunter.sql 明确 ADD COLUMN；0055 快照把它抹掉且区间内无 DROP COLUMN——属 db:generate 快照错位的历史残留（复核日期：2026-09-15）",
  "submissions.artifact_storage_url":
    "0054_hard_scalphunter.sql 明确 ADD COLUMN；0055 快照把它抹掉且区间内无 DROP COLUMN——属 db:generate 快照错位的历史残留（复核日期：2026-09-15）",
  "problems.problems_submission_mode_check":
    "0054_hard_scalphunter.sql 明确 ADD CONSTRAINT；0055 快照把它抹掉且区间内无 DROP CONSTRAINT——与上面三条同属一次快照错位（复核日期：2026-09-15）",
};

/** 单条 DROP 语句的作用对象。 */
export interface DropStatement {
  /** drop_table | drop_column | drop_index | drop_constraint */
  action: string;
  /** 目标表名；drop_table / drop_index 解析不到所属表时为 null */
  table: string | null;
  /** 目标列名（drop_column）或约束/索引名（drop_index/drop_constraint） */
  target: string;
  /** 来源迁移文件名 */
  file: string;
  /** 迁移文件名的数字前缀（解析不到时为 null） */
  number: number | null;
}

/** 从迁移文件名解析数字前缀。 */
export function migrationNumber(file: string): number | null {
  const match = file.match(/(\d+)[^/\\]*\.sql$/i);
  return match ? Number(match[1]) : null;
}

/**
 * 把 `ALTER TABLE a, b` / 带 schema 前缀 / 带引号的标识符规范化成裸表名。
 */
function normalizeIdent(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const last = raw.split(".").pop() ?? raw;
  return last.replace(/^"|"$/g, "").trim() || null;
}

/**
 * 从迁移 SQL 文本中提取全部结构性 DROP 语句。
 *
 * 为什么需要 `block` 参数：`0007_fk_cascade.sql`、`0054_hard_scalphunter.sql` 这类迁移
 * 用**多行单条语句**书写（`ALTER TABLE problems\n  DROP CONSTRAINT ...`），
 * 若只按 `--> statement-breakpoint` 切片，"目标表"与"DROP 子句"会落在不同片段里。
 * 因此这里以**整个文件文本**为输入逐条正则提取，并用 `table` 回填"最近的 ALTER TABLE 目标"，
 * 保证"哪张表的哪一列被删"能对上。
 */
export function parseDropStatements(
  sql: string,
  file = "",
): DropStatement[] {
  const out: DropStatement[] = [];
  const number = migrationNumber(file);
  const push = (action: string, table: string | null, target: string) => {
    out.push({ action, table, target, file, number });
  };

  // DROP TABLE
  for (
    const match of sql.matchAll(
      /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:"?[a-z_]+"?\.)?"?[a-z0-9_]+"?)/gi,
    )
  ) {
    const table = normalizeIdent(match[1]);
    if (table) push("drop_table", table, table);
  }

  // 逐条 ALTER TABLE：在其内部查找 DROP COLUMN / DROP CONSTRAINT
  for (
    const alter of sql.matchAll(
      /ALTER\s+TABLE\s+(?:ONLY\s+)?([a-z0-9_".]+)\s+([\s\S]*?);/gi,
    )
  ) {
    const table = normalizeIdent(alter[1]);
    const body = alter[2] ?? "";

    for (
      const match of body.matchAll(
        /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?("?[a-z0-9_]+"?)/gi,
      )
    ) {
      const target = normalizeIdent(match[1]);
      if (target) push("drop_column", table, target);
    }

    for (
      const match of body.matchAll(
        /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?("?[a-z0-9_]+"?)/gi,
      )
    ) {
      const target = normalizeIdent(match[1]);
      if (target) push("drop_constraint", table, target);
    }
  }

  // 兜底：多行 ALTER TABLE 中 DROP 子句与 ALTER TABLE 之间被注释/空行打断，
  // 或 ALTER TABLE 未以 `;` 结束（0007/0054 的写法）。此时按"最近的 ALTER TABLE"回填。
  const looseAlterRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?([a-z0-9_".]+)/gi;
  const alterTargets: Array<{ index: number; table: string | null }> = [];
  for (const match of sql.matchAll(looseAlterRe)) {
    alterTargets.push({
      index: match.index ?? 0,
      table: normalizeIdent(match[1]),
    });
  }
  const nearestTable = (index: number): string | null => {
    let found: string | null = null;
    for (const target of alterTargets) {
      if (target.index <= index) found = target.table;
      else break;
    }
    return found;
  };
  const seen = new Set(out.map((d) => `${d.action}|${d.table}|${d.target}`));
  for (
    const match of sql.matchAll(
      /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?("?[a-z0-9_]+"?)/gi,
    )
  ) {
    const target = normalizeIdent(match[1]);
    if (!target) continue;
    const key = `drop_column|${nearestTable(match.index ?? 0)}|${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    push("drop_column", nearestTable(match.index ?? 0), target);
  }

  // DROP INDEX（PostgreSQL 的 DROP INDEX 不带表名，按索引名匹配）
  for (
    const match of sql.matchAll(
      /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?((?:"?[a-z_]+"?\.)?"?[a-z0-9_]+"?)/gi,
    )
  ) {
    const target = normalizeIdent(match[1]);
    if (target) push("drop_index", null, target);
  }

  return out;
}

/** 从全部迁移 SQL 中提取被显式 `DROP TABLE` 的表名（**不做作用域限定**，仅供自检与报告）。 */
export async function droppedTableNames(
  dir = MIGRATIONS_DIR,
): Promise<Set<string>> {
  const names = new Set<string>();
  for await (
    const entry of walk(dir, {
      maxDepth: 1,
      includeDirs: false,
      exts: [".sql"],
    })
  ) {
    const text = await Deno.readTextFile(entry.path);
    for (const drop of parseDropStatements(text, entry.path)) {
      if (drop.action === "drop_table") names.add(drop.target);
    }
  }
  return names;
}

/** 读取迁移目录下全部迁移的 (编号, 文件, 文本)。 */
async function readMigrations(
  dir: string,
): Promise<Array<{ number: number | null; file: string; text: string }>> {
  const files: string[] = [];
  try {
    for await (
      const entry of walk(dir, {
        maxDepth: 1,
        includeDirs: false,
        exts: [".sql"],
      })
    ) {
      files.push(entry.path);
    }
  } catch {
    return [];
  }
  const out = [];
  for (const file of files.sort()) {
    out.push({
      number: migrationNumber(file),
      file,
      text: await Deno.readTextFile(file),
    });
  }
  return out;
}

/**
 * 取出"作用区间"内的 DROP 语句集合。
 *
 * 区间定义：迁移编号 ∈ (previousNumber, currentNumber]。编号解析不到的迁移一律纳入
 * （宁可多给一点豁免，也不要因解析失败造成假阳性）。
 */
export function dropsBetween(
  drops: DropStatement[],
  previousNumber: number,
  currentNumber: number,
): DropStatement[] {
  return drops.filter((drop) =>
    drop.number === null ||
    (drop.number > previousNumber && drop.number <= currentNumber)
  );
}

/** 从快照文件路径解析编号。 */
export function snapshotNumber(file: string): number {
  return Number(file.match(/(\d+)_snapshot\.json$/)?.[1] ?? 0);
}

/**
 * 检查快照链完整性。
 *
 * 判定口径（区分"有意移除"与"事故性丢失"）：
 * - 表在后续快照中消失，且**消失区间内**存在显式 `DROP TABLE` → 合法（可评审的删除）；
 * - 表在后续快照中消失，且在 `INTENTIONAL_REMOVALS` 登记 → 合法（跨服务移交）；
 * - 列/索引在后续快照中消失，且**消失区间内**存在对应 `DROP COLUMN` / `DROP INDEX` /
 *   被 DROP 的同名 unique 约束 → 合法；
 * - 列在 `LEGACY_RENUMBERING_ARTIFACTS` 登记 → 合法（历史错位残留，必须附证据）；
 * - 其余消失 → **事故**（曾导致 db:generate 重发 CREATE TABLE / ADD COLUMN）。
 *
 * @param snapshotDir 快照目录（测试可指向临时目录）
 * @param migrationsDir 迁移目录（测试可指向临时目录）
 * @param schemaDir 代码 schema 目录（测试可指向临时目录）
 * @returns 问题列表；为空表示通过。
 */
export async function checkSnapshotChain(
  snapshotDir = SNAPSHOT_DIR,
  migrationsDir = MIGRATIONS_DIR,
  schemaDir = SCHEMA_DIR,
): Promise<SnapshotChainIssue[]> {
  const issues: SnapshotChainIssue[] = [];
  const files = await listSnapshots(snapshotDir);
  if (files.length === 0) {
    issues.push({
      kind: "code_snapshot_mismatch",
      detail: `${snapshotDir} 下没有任何快照文件——门禁失去检查对象，判定失败`,
    });
    return issues;
  }

  const migrations = await readMigrations(migrationsDir);
  const allDrops: DropStatement[] = migrations.flatMap((migration) =>
    parseDropStatements(migration.text, migration.file)
  );

  let previous: {
    file: string;
    number: number;
    tables: Map<string, TableStructure>;
  } | null = null;
  for (const file of files) {
    const snapshot = JSON.parse(await Deno.readTextFile(file));
    const tables = tableStructuresOf(snapshot);
    const number = snapshotNumber(file);
    if (previous) {
      const scoped = dropsBetween(allDrops, previous.number, number);
      const droppedTables = new Set(
        scoped.filter((d) => d.action === "drop_table").map((d) => d.target),
      );
      const droppedColumns = new Set(
        scoped.filter((d) => d.action === "drop_column")
          .map((d) => `${d.table}.${d.target}`),
      );
      const droppedIndexes = new Set(
        scoped.filter((d) =>
          d.action === "drop_index" || d.action === "drop_constraint"
        ).map((d) => d.target),
      );

      for (const [name, before] of previous.tables) {
        const after = tables.get(name);
        if (!after) {
          if (droppedTables.has(name)) continue;
          if (INTENTIONAL_REMOVALS[name]) continue;
          issues.push({
            kind: "missing_in_later_snapshot",
            detail:
              `表 ${name} 存在于 ${previous.file}，但在 ${file} 中消失，` +
              `且 ${
                previous.number + 1
              }~${number} 区间的迁移里没有任何 DROP TABLE。` +
              `静默丢表会让下一次 db:generate 重新生成 CREATE TABLE，进而在存量库上以 ` +
              `already exists 失败。若确为有意移除，请在该区间补一条 DROP TABLE 迁移` +
              `或在 INTENTIONAL_REMOVALS 登记理由`,
          });
          continue;
        }

        for (const colName of before.columns.keys()) {
          if (after.columns.has(colName)) continue;
          if (droppedColumns.has(`${name}.${colName}`)) continue;
          if (LEGACY_RENUMBERING_ARTIFACTS[`${name}.${colName}`]) continue;
          issues.push({
            kind: "missing_column_in_later_snapshot",
            detail:
              `列 ${name}.${colName} 存在于 ${previous.file}，但在 ${file} 中消失，` +
              `且 ${
                previous.number + 1
              }~${number} 区间的迁移里没有 DROP COLUMN。` +
              `静默丢列会让下一次 db:generate 生成 ALTER TABLE ... ADD COLUMN，` +
              `在已含该列的存量库上以 column already exists 失败。` +
              `若确为有意删列，请在该区间补一条 DROP COLUMN 迁移`,
          });
        }

        for (const [idxName] of before.indexes) {
          if (after.indexes.has(idxName)) continue;
          if (droppedIndexes.has(idxName)) continue;
          issues.push({
            kind: "missing_index_in_later_snapshot",
            detail:
              `索引 ${name}.${idxName} 存在于 ${previous.file}，但在 ${file} 中消失，` +
              `且 ${
                previous.number + 1
              }~${number} 区间的迁移里没有 DROP INDEX / ` +
              `DROP CONSTRAINT。静默丢索引会让下一次 db:generate 生成 ` +
              `CREATE INDEX / ALTER TABLE ... ADD CONSTRAINT，在已有该索引的存量库上失败。` +
              `若确为有意删除，请在该区间补一条 DROP INDEX 或 DROP CONSTRAINT 迁移`,
          });
        }

        for (const [section, kind] of Object.entries(CONSTRAINT_SECTIONS)) {
          const beforeSection = before.constraints.get(section);
          const afterSection = after.constraints.get(section);
          for (const [constraintName] of beforeSection ?? []) {
            if (afterSection?.has(constraintName)) continue;
            if (droppedIndexes.has(constraintName)) continue;
            if (LEGACY_RENUMBERING_ARTIFACTS[`${name}.${constraintName}`]) {
              continue;
            }
            issues.push({
              kind,
              detail: `${CONSTRAINT_SECTION_LABELS[section] ?? section} ` +
                `${name}.${constraintName} 存在于 ${previous.file}，但在 ${file} 中消失，` +
                `且 ${previous.number + 1}~${number} 区间的迁移里没有对应的 ` +
                `DROP CONSTRAINT / DROP INDEX。静默丢失会让下一次 db:generate 重新生成 ` +
                `ADD CONSTRAINT / CREATE INDEX，在已有该对象的存量库上失败。` +
                `若确为有意删除，请在该区间补一条 DROP CONSTRAINT 迁移`,
            });
          }
        }
      }
    }
    previous = { file, number, tables };
  }

  // 自检：解析不到表说明解析规则已与快照结构脱节
  if (previous && previous.tables.size === 0) {
    issues.push({
      kind: "code_snapshot_mismatch",
      detail:
        `最新快照 ${previous.file} 解析到 0 张表——解析规则可能已失效，判定失败`,
    });
    return issues;
  }

  const latest = previous!;

  // 自检：最新快照必须真的解析到列，否则"结构化摘要"退化成空壳（恒真门禁）
  const latestColumnCount = [...latest.tables.values()]
    .reduce((sum, table) => sum + table.columns.size, 0);
  if (latestColumnCount === 0) {
    issues.push({
      kind: "code_snapshot_mismatch",
      detail:
        `最新快照 ${latest.file} 解析到 0 列——列级摘要解析可能已失效，判定失败`,
    });
    return issues;
  }

  if (schemaDir) {
    const codeTables = await codeTableNames(schemaDir);
    if (codeTables.size === 0) {
      issues.push({
        kind: "code_snapshot_mismatch",
        detail:
          `${schemaDir} 下未解析到任何 pgTable 定义——解析规则可能已失效，判定失败`,
      });
      return issues;
    }

    for (const name of codeTables) {
      if (!latest.tables.has(name)) {
        issues.push({
          kind: "code_snapshot_mismatch",
          detail:
            `表 ${name} 在代码中定义，但不在最新快照 ${latest.file} 中——` +
            `下一次 db:generate 会把它当作新表生成 CREATE TABLE`,
        });
      }
    }
  }

  if (migrationsDir) {
    const created = await createdTableNames(migrationsDir);
    if (created.size === 0) {
      issues.push({
        kind: "never_created",
        detail:
          `${migrationsDir} 下未解析到任何 CREATE TABLE——解析规则可能已失效，判定失败`,
      });
      return issues;
    }
    for (const name of latest.tables.keys()) {
      if (!created.has(name)) {
        issues.push({
          kind: "never_created",
          detail:
            `表 ${name} 在最新快照中，但没有任何迁移包含 CREATE TABLE ${name}`,
        });
      }
    }
  }

  return issues;
}

if (import.meta.main) {
  // 可选第一个位置参数 = 快照目录（默认 noj-core/drizzle/meta）。
  // 存在意义：评审/回归时可以把快照目录复制到临时位置、人为损坏后指向它复现门禁行为，
  // 而不触碰真实 drizzle 目录。CI（scripts/check-ci.ts）不传参，行为与旧版一致。
  const snapshotDir = Deno.args[0] ?? SNAPSHOT_DIR;
  const issues = await checkSnapshotChain(snapshotDir);
  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`[快照链] (${issue.kind}) ${issue.detail}`);
    }
    console.error(
      `\n快照链检查失败：${issues.length} 项。规则见 scripts/check-migration-snapshot-chain.ts 顶部说明。`,
    );
    Deno.exit(1);
  }
  console.log("drizzle 快照链检查通过（表/列/索引单调且与代码一致）");
}
