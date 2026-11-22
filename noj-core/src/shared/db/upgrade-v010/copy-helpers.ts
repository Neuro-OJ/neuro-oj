/**
 * `v0.10.6 → v0.11` 目标库元数据内省、确定性 UUID、批量参数化写入与校验辅助。
 *
 * 仅使用参数化 SQL；标识符必须通过白名单正则校验后才可双引号拼接。
 */

import type postgres from "postgres";
import { UpgradeV010Error } from "./types.ts";

export type PgClient = ReturnType<typeof postgres>;
/** `postgres.js` 查询/事务执行器统一类型（`Sql` 兼容 `TransactionSql` 调用签名）。 */
export type PgExecutor = postgres.TransactionSql<Record<string, unknown>>;

const PG_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;
const MAX_PARAMS_PER_BATCH = 40_000;
const DEFAULT_BATCH_SIZE = 250;

/** 校验 PostgreSQL 表名或列名，防止标识符注入。 */
export function assertPgIdentifier(name: string): string {
  if (!PG_IDENTIFIER_RE.test(name)) {
    throw new UpgradeV010Error(
      "DATA_INTEGRITY_ERROR",
      `非法 PostgreSQL 标识符: ${name}`,
      { identifier: name },
    );
  }
  return name;
}

/** 目标表可写列元数据（已排除 `GENERATED ALWAYS` 列）。 */
export interface TargetColumnMeta {
  name: string;
  dataType: string;
  udtName: string;
  isNullable: boolean;
}

/** 根据字符串部件计算确定性 RFC 4122 UUID（SHA-256 截断编码）。 */
export async function deterministicUuid(
  namespace: string,
  ...parts: string[]
): Promise<string> {
  const input = new TextEncoder().encode([namespace, ...parts].join("\0"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const bytes = digest.slice(0, 16);
  // 写入 version=4 与 RFC 4122 variant=10xx 位，兼容标准 UUID 校验器
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20, 32)}`;
}

/** 查询 `public` schema 下全部基础表名（升序）。 */
export async function listPublicTables(sql: PgExecutor): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name ASC
  `;
  return rows.map((r) => String(r.table_name));
}

/** 查询目标表可写入列（按 `ordinal_position` 排序，自动跳过生成列）。 */
export async function getTargetInsertColumns(
  sql: PgExecutor,
  tableName: string,
): Promise<TargetColumnMeta[]> {
  assertPgIdentifier(tableName);
  const rows = await sql<{
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
  }[]>`
    SELECT column_name, data_type, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${tableName}
      AND is_generated <> 'ALWAYS'
    ORDER BY ordinal_position ASC
  `;
  if (rows.length === 0) {
    throw new UpgradeV010Error(
      "TARGET_INVALID_SCHEMA",
      `目标库缺少必需表或可写列: ${tableName}`,
      { table: tableName },
    );
  }
  return rows.map((r) => ({
    name: assertPgIdentifier(String(r.column_name)),
    dataType: String(r.data_type),
    udtName: String(r.udt_name),
    isNullable: String(r.is_nullable).toUpperCase() === "YES",
  }));
}

function sqlCastForColumn(col: TargetColumnMeta): string {
  switch (col.udtName) {
    case "jsonb":
    case "json":
      // 经 client.json() 打包后参数已带 jsonb OID，不再追加 ::jsonb 避免类型冲突
      return "";
    case "_text":
      return "::text[]";
    case "int8":
      return "::bigint";
    case "int4":
      return "::integer";
    case "int2":
      return "::smallint";
    case "bool":
      return "::boolean";
    case "float8":
      return "::double precision";
    case "float4":
      return "::real";
    case "timestamptz":
      return "::timestamptz";
    case "timestamp":
      return "::timestamp";
    default:
      return col.dataType === "ARRAY" ? "::text[]" : "::text";
  }
}

export type JsonParamSerializer = (value: unknown) => unknown;

function serializeCell(
  col: TargetColumnMeta,
  value: unknown,
  serializeJson: JsonParamSerializer,
): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (col.udtName === "jsonb" || col.udtName === "json") {
    return serializeJson(value);
  }
  if (col.udtName === "int8" && typeof value !== "string") {
    return String(value);
  }
  return value;
}

/** 读取源表全部行；空表返回空数组。 */
export async function readAllRows<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  sql: PgExecutor,
  tableName: string,
  orderByClause = "",
): Promise<T[]> {
  assertPgIdentifier(tableName);
  const query = orderByClause
    ? `SELECT * FROM "${tableName}" ${orderByClause}`
    : `SELECT * FROM "${tableName}"`;
  return await sql.unsafe<T[]>(query);
}

/**
 * 按列元数据和 PostgreSQL 参数上限分批插入目标表。
 *
 * 自动跳过 `GENERATED ALWAYS` 列，并为 `jsonb`、`bigint`、`text[]` 添加显式类型转换。
 */
export async function insertRowsBatched(
  tx: PgExecutor,
  tableName: string,
  columns: readonly TargetColumnMeta[],
  rows: readonly Record<string, unknown>[],
  serializeJson: JsonParamSerializer,
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<number> {
  if (rows.length === 0) return 0;
  assertPgIdentifier(tableName);

  const safeBatchSize = Math.max(
    1,
    Math.min(batchSize, Math.floor(MAX_PARAMS_PER_BATCH / columns.length)),
  );
  const colNamesSql = columns.map((c) => `"${c.name}"`).join(", ");
  const casts = columns.map(sqlCastForColumn);

  for (let offset = 0; offset < rows.length; offset += safeBatchSize) {
    const chunk = rows.slice(offset, offset + safeBatchSize);
    const params: unknown[] = [];
    const valueTuples: string[] = [];

    for (const row of chunk) {
      const placeholders: string[] = [];
      for (let cIdx = 0; cIdx < columns.length; cIdx += 1) {
        const col = columns[cIdx]!;
        if (!(col.name in row)) {
          throw new UpgradeV010Error(
            "DATA_INTEGRITY_ERROR",
            `写入表 ${tableName} 时缺少列 ${col.name}`,
            { table: tableName, column: col.name },
          );
        }
        params.push(serializeCell(col, row[col.name], serializeJson));
        placeholders.push(`$${params.length}${casts[cIdx]}`);
      }
      valueTuples.push(`(${placeholders.join(", ")})`);
    }

    const query = `INSERT INTO "${tableName}" (${colNamesSql}) VALUES ${
      valueTuples.join(", ")
    }`;
    // 参数数量与类型转换已精确对齐目标表列元数据
    await tx.unsafe(query, params as never[]);
  }

  return rows.length;
}

/** 查询给定表当前精确行数（同事务内校验用）。 */
export async function countTableRows(
  sql: PgExecutor,
  tableName: string,
): Promise<number> {
  assertPgIdentifier(tableName);
  const rows = await sql.unsafe<{ count: string }[]>(
    `SELECT count(*)::text AS count FROM "${tableName}"`,
  );
  return Number(rows[0]?.count ?? "0");
}
