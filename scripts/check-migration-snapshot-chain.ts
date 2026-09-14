// deno-lint-ignore-file no-explicit-any -- drizzle snapshot 为外部 JSON 结构
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
 * 本门禁做两件事：
 * 1. **快照链单调性**：后一个快照不能比前一个**少表**（表只增不减，删表须走显式迁移）；
 * 2. **快照 vs 代码一致性**：代码里 `pgTable("...")` 定义的表集合必须与最新快照一致，
 *    且最新快照中的表必须都真的被某条迁移创建过（防止"快照有、迁移没有"）。
 *
 * 自检：解析不到任何表定义时判定失败并退出非零，避免"路径漂移后永远报绿"。
 */
import { walk } from "jsr:@std/fs@^1/walk";

/** 单条问题描述。 */
export interface SnapshotChainIssue {
  kind:
    | "missing_in_later_snapshot"
    | "code_snapshot_mismatch"
    | "never_created";
  detail: string;
}

const SNAPSHOT_DIR = "noj-core/drizzle/meta";
const MIGRATIONS_DIR = "noj-core/drizzle";
const SCHEMA_DIR = "noj-core/src/shared/db/schema";

/** 读取快照文件中的表名集合（去掉 `public.` 前缀）。 */
export function tableNamesOf(snapshot: any): Set<string> {
  const tables = snapshot?.tables ?? {};
  return new Set(
    Object.keys(tables).map((key) =>
      key.includes(".") ? key.split(".").pop()! : key
    ),
  );
}

/** 按文件名顺序列出全部快照文件（0000 → 0081）。 */
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

/** 从全部迁移 SQL 中提取被显式 `DROP TABLE` 的表名。 */
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
    for (
      const match of text.matchAll(
        /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?[a-z_]+"?\.)?"?([a-z0-9_]+)"?/gi,
      )
    ) {
      names.add(match[1]!);
    }
  }
  return names;
}

/**
 * 检查快照链完整性。
 *
 * 判定口径（区分"有意移除"与"事故性丢表"）：
 * - 表在后续快照中消失，但**存在显式 `DROP TABLE` 迁移** → 合法（可评审的删除）；
 * - 表在后续快照中消失，且在 `INTENTIONAL_REMOVALS` 登记 → 合法（跨服务移交）；
 * - 其余消失 → **事故**（曾导致 db:generate 重发 CREATE TABLE）。
 *
 * @returns 问题列表；为空表示通过。
 */
export async function checkSnapshotChain(): Promise<SnapshotChainIssue[]> {
  const issues: SnapshotChainIssue[] = [];
  const files = await listSnapshots();
  if (files.length === 0) {
    issues.push({
      kind: "code_snapshot_mismatch",
      detail: `${SNAPSHOT_DIR} 下没有任何快照文件——门禁失去检查对象，判定失败`,
    });
    return issues;
  }

  const dropped = await droppedTableNames();

  let previous: { file: string; tables: Set<string> } | null = null;
  for (const file of files) {
    const snapshot = JSON.parse(await Deno.readTextFile(file));
    const tables = tableNamesOf(snapshot);
    if (previous) {
      for (const name of previous.tables) {
        if (tables.has(name)) continue;
        if (dropped.has(name)) continue;
        if (INTENTIONAL_REMOVALS[name]) continue;
        issues.push({
          kind: "missing_in_later_snapshot",
          detail: `表 ${name} 存在于 ${previous.file}，但在 ${file} 中消失，` +
            `且没有任何 DROP TABLE 迁移。静默丢表会让下一次 db:generate 重新生成 ` +
            `CREATE TABLE，进而在存量库上以 already exists 失败。` +
            `若确为有意移除，请补一条 DROP TABLE 迁移或在 INTENTIONAL_REMOVALS 登记理由`,
        });
      }
    }
    previous = { file, tables };
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
  const codeTables = await codeTableNames();
  if (codeTables.size === 0) {
    issues.push({
      kind: "code_snapshot_mismatch",
      detail:
        `${SCHEMA_DIR} 下未解析到任何 pgTable 定义——解析规则可能已失效，判定失败`,
    });
    return issues;
  }

  for (const name of codeTables) {
    if (!latest.tables.has(name)) {
      issues.push({
        kind: "code_snapshot_mismatch",
        detail: `表 ${name} 在代码中定义，但不在最新快照 ${latest.file} 中——` +
          `下一次 db:generate 会把它当作新表生成 CREATE TABLE`,
      });
    }
  }

  const created = await createdTableNames();
  for (const name of latest.tables) {
    if (!created.has(name)) {
      issues.push({
        kind: "never_created",
        detail:
          `表 ${name} 在最新快照中，但没有任何迁移包含 CREATE TABLE ${name}`,
      });
    }
  }

  return issues;
}

if (import.meta.main) {
  const issues = await checkSnapshotChain();
  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`[快照链] (${issue.kind}) ${issue.detail}`);
    }
    console.error(
      `\n快照链检查失败：${issues.length} 项。规则见 scripts/check-migration-snapshot-chain.ts 顶部说明。`,
    );
    Deno.exit(1);
  }
  console.log("drizzle 快照链检查通过（表集合单调且与代码一致）");
}
