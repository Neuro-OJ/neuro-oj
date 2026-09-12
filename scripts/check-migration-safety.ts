/**
 * 迁移安全性静态门禁。
 *
 * 背景（2026-09-12 架构评审 §2.1）：`drizzle/0080_woozy_romulus.sql` 由 drizzle-kit
 * 生成为 `ADD COLUMN "updated_at" text NOT NULL`（无 DEFAULT、无回填）。PostgreSQL
 * 允许**空表**直接添加 NOT NULL 列，因此唯一执行文件迁移的测试（跑在空库上）无法
 * 发现该缺陷——只有**存量库**升级时才会失败，而失败会让整批迁移回滚、core 无法启动
 * （`depends_on: migrate: service_completed_successfully`）。
 *
 * 本门禁静态拦截这一类写法：向**已存在的表**添加 NOT NULL 列，必须带 DEFAULT 或
 * 采用三步式（加可空列 → 回填 → SET NOT NULL）。
 *
 * 自检：如果扫描不到任何迁移文件、或一条 `ALTER TABLE ... ADD COLUMN` 都没解析到，
 * 则判定门禁自身失效并**失败**——防止"脚本存在、路径失效、永远报绿"这类假绿灯
 * （同类缺陷见 scripts/verify-capability-seams.ts 的历史问题）。
 */

export interface UnsafeAddColumn {
  file: string;
  statement: string;
  reason: string;
}

/** 迁移文件中的单条语句（已剥离行注释、去掉结尾分号） */
export interface MigrationStatement {
  file: string;
  text: string;
}

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/**
 * 把一段 SQL 切成单条语句（以 `;` 分隔）。
 *
 * 必要性：仓库中 **38/83 个迁移文件完全没有 `--> statement-breakpoint` 标记**，
 * 一个"块"里含多条语句。若直接对整块做正则匹配，`ADD COLUMN` 之后的
 * `CHECK (... IS NOT NULL)`、`CREATE INDEX ... WHERE ... IS NOT NULL` 会被当成
 * 加列语句的一部分，产生误报（实测：0017_problem_runtime_config.sql）。
 *
 * 处理单引号字符串与 `$$` 美元引用（0021 使用），避免在字符串/函数体内错误切分。
 */
export function splitSqlStatements(chunk: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDollar = false;
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];
    if (!inSingle && chunk.slice(i, i + 2) === "$$") {
      inDollar = !inDollar;
      buf += "$$";
      i++;
      continue;
    }
    if (!inDollar) {
      if (ch === "'") {
        if (inSingle && chunk[i + 1] === "'") {
          buf += "''";
          i++;
          continue;
        }
        inSingle = !inSingle;
      } else if (ch === ";" && !inSingle) {
        if (buf.trim()) out.push(buf.trim());
        buf = "";
        continue;
      }
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** 按 drizzle 的语句分隔标记切分迁移文件，并剥离 `--` 行注释 */
export function splitMigrationStatements(
  file: string,
  content: string,
): MigrationStatement[] {
  const withoutComments = content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(STATEMENT_BREAKPOINT)
    .map((s) => s.trim().replace(/;+$/, "").trim())
    .filter((s) => s.length > 0)
    .map((text) => ({ file, text }));
}

/**
 * 判断单条语句是否为"不安全的加列"。
 *
 * 不安全 = `ALTER TABLE ... ADD COLUMN ... NOT NULL` 且没有 `DEFAULT`。
 * 带 DEFAULT 的加列在 PG 11+ 是安全的（元数据默认值，不回写全表）；
 * 三步式写法中加列语句本身不带 NOT NULL，因此不会被误报。
 */
export function isUnsafeNotNullAddColumn(statement: string): boolean {
  if (!/^\s*ALTER\s+TABLE/i.test(statement)) return false;
  if (!/ADD\s+COLUMN/i.test(statement)) return false;
  if (!/NOT\s+NULL/i.test(statement)) return false;
  // 带 DEFAULT 即安全
  if (/\bDEFAULT\b/i.test(statement)) return false;
  return true;
}

export function findUnsafeAddColumns(
  statements: MigrationStatement[],
): UnsafeAddColumn[] {
  const found: UnsafeAddColumn[] = [];
  for (const chunk of statements) {
    for (const single of splitSqlStatements(chunk.text)) {
      if (isUnsafeNotNullAddColumn(single)) {
        found.push({
          file: chunk.file,
          statement: single,
          reason:
            "向已存在的表添加 NOT NULL 列但没有 DEFAULT：存量库必失败。请改为三步式（加可空列 → 回填 → SET NOT NULL）。",
        });
      }
    }
  }
  return found;
}

/** 扫描迁移目录；返回错误列表（空数组 = 通过） */
export async function checkMigrationSafety(
  migrationsDir = "noj-core/drizzle",
): Promise<string[]> {
  const errors: string[] = [];

  let files: string[] = [];
  try {
    for await (const entry of Deno.readDir(migrationsDir)) {
      if (entry.isFile && entry.name.endsWith(".sql")) {
        files.push(`${migrationsDir}/${entry.name}`);
      }
    }
  } catch (err) {
    return [`无法读取迁移目录 ${migrationsDir}: ${(err as Error).message}`];
  }
  files = files.sort();

  // 自检 1：迁移目录必须真的被读到
  if (files.length === 0) {
    return [
      `迁移目录 ${migrationsDir} 中没有任何 .sql 文件——门禁已失去检查对象，判定失败（防止路径漂移后的假绿灯）`,
    ];
  }

  const allStatements: MigrationStatement[] = [];
  for (const file of files) {
    const content = await Deno.readTextFile(file);
    allStatements.push(...splitMigrationStatements(file, content));
  }

  // 自检 2：必须至少解析到一条加列语句，否则说明解析规则与迁移写法已脱节
  const addColumnCount = allStatements
    .flatMap((s) => splitSqlStatements(s.text))
    .filter((s) => /ADD\s+COLUMN/i.test(s)).length;
  if (addColumnCount === 0) {
    errors.push(
      `在 ${files.length} 个迁移文件中未解析到任何 ADD COLUMN 语句——解析规则可能已与迁移写法脱节，判定失败（防止恒真门禁）`,
    );
  }

  for (const bad of findUnsafeAddColumns(allStatements)) {
    errors.push(`${bad.file}: ${bad.statement}\n    → ${bad.reason}`);
  }

  return errors;
}

if (import.meta.main) {
  const errors = await checkMigrationSafety();
  if (errors.length > 0) {
    for (const e of errors) console.error(`[迁移安全] ${e}`);
    console.error(
      `\n迁移安全检查失败：${errors.length} 项。规则见 scripts/check-migration-safety.ts 顶部说明。`,
    );
    Deno.exit(1);
  }
  console.log("迁移安全检查通过（无一步式 NOT NULL 加列）");
}
