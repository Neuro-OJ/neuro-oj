/**
 * Seed 脚本：初始化示例题到数据库。
 *
 * 用法: deno task seed
 *
 * 此脚本从 data/packages/ 读取已构建的 support 包，
 * 将题目元数据写入数据库。支持幂等运行（ON CONFLICT DO NOTHING）。
 */

import { runMigrations } from "../src/db/migrate.ts";
import { getDb } from "../src/db/connection.ts";
import { problems } from "../src/db/schema.ts";

interface SampleProblem {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  judge_image: string;
  judge_command: string;
  support_package_path: string | null;
  time_limit_ms: number;
  memory_limit_mb: number;
}

const SAMPLE_PROBLEMS: SampleProblem[] = [
  {
    id: "1001",
    title: "1001 T0-LMCC：星港舱门报码归一化",
    description:
      "星港舱门报码归一化。将自然语言报码整理成标准 JSON（gate_id + status）。总分 10 分。",
    difficulty: "easy",
    judge_image: "noj-judge-python",
    judge_command: "python3 /tmp/evaluate.py",
    support_package_path: "data/packages/1001.zip",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
  },
];

async function seedProblems(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  for (const problem of SAMPLE_PROBLEMS) {
    // 使用 ON CONFLICT 确保幂等性
    await db
      .insert(problems)
      .values({
        ...problem,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoNothing({ target: problems.id });

    console.log(`已同步题目: ${problem.id} ${problem.title}`);
  }
}

async function main() {
  console.log("=".repeat(48));
  console.log("Seed 脚本启动");
  console.log("=".repeat(48));

  // 1. 运行迁移
  try {
    await runMigrations();
  } catch (err) {
    console.error("数据库迁移失败:", err);
    Deno.exit(1);
  }

  // 2. 插入示例题
  try {
    await seedProblems();
  } catch (err) {
    console.error("示例题插入失败:", err);
    Deno.exit(1);
  }

  console.log("Seed 完成");
}

await main();
