/**
 * schema-ddl.ts ↔ Drizzle schema 一致性门禁（2026-09-12 架构评审 §3.3）。
 *
 * 背景：`noj-core/src/shared/db/schema-ddl.ts` 是 Drizzle schema 的**手工 SQL 副本**，
 * 仅供 PGlite 测试模式建表。它没有任何自动化 parity 校验——
 * 一旦漂移，症状是"测试跑在手工 SQL 上、与生产行为不一致"，比测试失败更危险。
 *
 * 本门禁比对两侧的**表集合与列集合**（不比对索引/约束细节，那部分噪声大且价值低）：
 * - 以 Drizzle schema 为事实源（`getTableName` / `getTableColumns`）；
 * - 解析 `SCHEMA_DDL` 中的 `CREATE TABLE IF NOT EXISTS` 语句取表与列；
 * - 任一侧多出/缺少表或列都失败。
 *
 * 自检：Drizzle 侧表数或 DDL 侧表数为 0、DDL 里解析不到任何列 → 判定门禁失效。
 */

import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/shared/db/schema.ts";
import { SCHEMA_DDL } from "../src/shared/db/schema-ddl.ts";

/** 从 Drizzle schema 提取 表名 → 列名集合 */
export function drizzleTables(
  schemaModule: Record<string, unknown>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const value of Object.values(schemaModule)) {
    if (!is(value, PgTable)) continue;
    const name = getTableName(value);
    const columns = new Set(
      Object.values(getTableColumns(value)).map((c) => c.name),
    );
    out.set(name, columns);
  }
  return out;
}

/**
 * 解析 DDL 中所有 `CREATE TABLE [IF NOT EXISTS] name ( ... )` 的表与列。
 *
 * 处理要点：
 * - 表名可能带双引号（`"users"`）或不带（`users`）；
 * - 列定义与表级约束混在括号内，需跳过 PRIMARY KEY / FOREIGN KEY / UNIQUE /
 *   CHECK / CONSTRAINT / EXCLUDE 等约束行；
 * - 列名后可能直接跟类型，也可能带方括号/引号形式（本项目未使用，保守处理）。
 */
export function parseDdlTables(
  ddl: readonly string[],
): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const createRe =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][\w]*))\s*\(/gi;

  for (const statement of ddl) {
    createRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = createRe.exec(statement)) !== null) {
      const tableName = match[1] ?? match[2];
      // 从 '(' 之后按括号深度扫描到匹配的 ')'
      let depth = 1;
      let i = createRe.lastIndex;
      const start = i;
      while (i < statement.length && depth > 0) {
        const ch = statement[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        i++;
      }
      const body = statement.slice(start, i - 1);
      // 必须先剥离 `--` 行注释：注释与其后的列会被同一次逗号切分归入同一段，
      // 导致该列被整段丢弃（实测：audit_logs.admin_id 上方的 PR-2 注释使本门禁
      // 误报"缺少列"——门禁自身的解析 bug 也会制造假信号）。
      const bodyWithoutComments = body
        .split("\n")
        .map((line) => {
          const idx = line.indexOf("--");
          return idx >= 0 ? line.slice(0, idx) : line;
        })
        .join("\n");
      const columns = new Set<string>();
      // 顶层逗号切分（忽略括号内的逗号，如 CHECK (a IN ('x','y'))）
      let buf = "";
      let inner = 0;
      const parts: string[] = [];
      for (const ch of bodyWithoutComments) {
        if (ch === "(") inner++;
        else if (ch === ")") inner--;
        if (ch === "," && inner === 0) {
          parts.push(buf);
          buf = "";
          continue;
        }
        buf += ch;
      }
      if (buf.trim()) parts.push(buf);

      const CONSTRAINT_KEYWORDS =
        /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|EXCLUDE)\b/i;
      for (const part of parts) {
        const line = part.trim();
        if (!line || CONSTRAINT_KEYWORDS.test(line)) continue;
        const nameMatch = line.match(/^(?:"([^"]+)"|([A-Za-z_][\w]*))/);
        const columnName = nameMatch?.[1] ?? nameMatch?.[2];
        if (columnName) columns.add(columnName);
      }
      tables.set(tableName, columns);
    }
  }
  return tables;
}

export interface SchemaParityResult {
  errors: string[];
  stats: {
    drizzle_tables: number;
    ddl_tables: number;
    compared_columns: number;
  };
}

export function compareSchemas(
  drizzle: Map<string, Set<string>>,
  ddl: Map<string, Set<string>>,
): string[] {
  const errors: string[] = [];

  for (const [table, columns] of drizzle) {
    const ddlColumns = ddl.get(table);
    if (!ddlColumns) {
      errors.push(
        `schema-ddl.ts 缺少表: ${table}（Drizzle 有 ${columns.size} 列）`,
      );
      continue;
    }
    for (const column of columns) {
      if (!ddlColumns.has(column)) {
        errors.push(`schema-ddl.ts 的表 ${table} 缺少列: ${column}`);
      }
    }
    for (const column of ddlColumns) {
      if (!columns.has(column)) {
        errors.push(
          `schema-ddl.ts 的表 ${table} 多出列: ${column}（Drizzle 无此列）`,
        );
      }
    }
  }
  for (const table of ddl.keys()) {
    if (!drizzle.has(table)) {
      errors.push(`schema-ddl.ts 多出表: ${table}（Drizzle 无此表）`);
    }
  }
  return errors;
}

export function checkSchemaParity(): SchemaParityResult {
  const drizzle = drizzleTables(schema as unknown as Record<string, unknown>);
  const ddl = parseDdlTables(SCHEMA_DDL);
  const errors: string[] = [];

  // ── 自检：两侧都必须真的解析到东西 ──
  if (drizzle.size === 0) {
    errors.push("未能从 Drizzle schema 解析到任何表——事实源或导入方式已失效");
  }
  if (ddl.size === 0) {
    errors.push("未能从 SCHEMA_DDL 解析到任何表——解析规则已与 DDL 写法脱节");
  }
  const ddlColumnCount = [...ddl.values()].reduce((acc, c) => acc + c.size, 0);
  if (ddlColumnCount === 0) {
    errors.push("未能从 SCHEMA_DDL 解析到任何列");
  }

  if (errors.length === 0) {
    errors.push(...compareSchemas(drizzle, ddl));
  }

  const comparedColumns = [...drizzle.values()].reduce(
    (acc, c) => acc + c.size,
    0,
  );
  return {
    errors,
    stats: {
      drizzle_tables: drizzle.size,
      ddl_tables: ddl.size,
      compared_columns: comparedColumns,
    },
  };
}

if (import.meta.main) {
  const { errors, stats } = checkSchemaParity();
  if (errors.length > 0) {
    console.error(
      "Schema 一致性检查失败（schema-ddl.ts 与 Drizzle schema 已漂移）：",
    );
    for (const e of errors) console.error(`- ${e}`);
    console.error(
      "\n请同步更新 noj-core/src/shared/db/schema-ddl.ts（PGlite 测试用 DDL 镜像）。",
    );
    Deno.exit(1);
  }
  console.log(
    `Schema 一致性检查通过（Drizzle ${stats.drizzle_tables} 表 / DDL ${stats.ddl_tables} 表 / 比对 ${stats.compared_columns} 列）`,
  );
}
