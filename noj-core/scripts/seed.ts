/**
 * Seed 脚本：初始化示例题到数据库。
 *
 * 用法: deno task seed
 *
 * 此脚本从 data/packages/ 读取已构建的 support 包，
 * 将题目元数据写入数据库。支持幂等运行（ON CONFLICT DO NOTHING）。
 *
 * 环境变量：
 *   ADMIN_EMAIL - 若设置，则将对应邮箱的用户角色提升为 admin
 */

import { eq } from "drizzle-orm";
import { runMigrations } from "../src/db/migrate.ts";
import { getDb } from "../src/db/connection.ts";
import {
  categories,
  problems,
  problemsCategories,
  users,
} from "../src/db/schema.ts";

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

/**
 * 示例分类定义。
 */
interface SampleCategory {
  id: string;
  name: string;
  slug: string;
  description: string;
  parent_id: string | null;
  level: number;
}

const SAMPLE_CATEGORIES: SampleCategory[] = [
  {
    id: "cat-algorithm",
    name: "算法",
    slug: "algorithm",
    description: "算法相关题目",
    parent_id: null,
    level: 0,
  },
  {
    id: "cat-data-structure",
    name: "数据结构",
    slug: "data-structure",
    description: "数据结构相关题目",
    parent_id: null,
    level: 0,
  },
  {
    id: "cat-tree",
    name: "树",
    slug: "tree",
    description: "树结构相关题目",
    parent_id: "cat-data-structure",
    level: 1,
  },
  {
    id: "cat-lmcc",
    name: "LMCC 样例题",
    slug: "lmcc-sample",
    description: "LMCC 样例题集",
    parent_id: null,
    level: 0,
  },
];

/**
 * 题目与分类的关联定义。
 */
const PROBLEM_CATEGORY_MAP: [string, string][] = [
  ["1001", "cat-lmcc"],
  ["1001", "cat-algorithm"],
];

async function seedProblems(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  for (const problem of SAMPLE_PROBLEMS) {
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

/**
 * 初始化示例分类。
 */
async function seedCategories(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  for (const cat of SAMPLE_CATEGORIES) {
    await db
      .insert(categories)
      .values({
        ...cat,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoNothing({ target: categories.id });

    console.log(`  已同步分类: ${cat.name} (${cat.slug})`);
  }
}

/**
 * 关联题目与分类。
 */
async function seedProblemCategories(): Promise<void> {
  const db = getDb();

  for (const [problemId, categoryId] of PROBLEM_CATEGORY_MAP) {
    await db
      .insert(problemsCategories)
      .values({ problem_id: problemId, category_id: categoryId })
      .onConflictDoNothing();

    console.log(`  已关联题目 ${problemId} → 分类 ${categoryId}`);
  }
}

/**
 * 根据 ADMIN_EMAIL 环境变量创建/提升管理员。
 *
 * ADMIN_EMAIL 必须设置。
 * 若 ADMIN_PASS 同时设置，则自动创建用户（不存在时）并设为 admin；
 * 若 ADMIN_PASS 未设置，则仅提升已存在的用户。
 */
async function ensureAdminFromEnv(): Promise<void> {
  const adminEmail = Deno.env.get("ADMIN_EMAIL");
  if (!adminEmail) {
    console.log("  ADMIN_EMAIL 未设置，跳过管理员");
    return;
  }

  const adminPass = Deno.env.get("ADMIN_PASS");
  const db = getDb();

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, adminEmail))
    .limit(1);

  if (existing.length === 0) {
    if (!adminPass) {
      console.warn(
        `  警告：用户 ${adminEmail} 不存在，且未设置 ADMIN_PASS，无法自动创建`,
      );
      return;
    }
    // 自动创建管理员用户
    const { hashPassword } = await import("../src/lib/password.ts");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const username = adminEmail.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "_");

    await db.insert(users).values({
      id,
      username,
      email: adminEmail,
      password_hash: await hashPassword(adminPass),
      role: "admin",
      created_at: now,
      updated_at: now,
    });
    console.log(`  已创建管理员用户: ${adminEmail} (${username})`);
    return;
  }

  const user = existing[0];
  if (user.role === "admin") {
    console.log(`  用户 ${adminEmail} 已是管理员，无需提升`);
    return;
  }

  await db
    .update(users)
    .set({ role: "admin", updated_at: new Date().toISOString() })
    .where(eq(users.email, adminEmail));

  console.log(`  已提升用户 ${adminEmail} 为管理员`);
}

async function main() {
  console.log("=".repeat(48));
  console.log("Seed 脚本启动");
  console.log("=".repeat(48));

  try {
    // 1. 运行迁移
    try {
      await runMigrations();
    } catch (err) {
      console.error("数据库迁移失败:", err);
      throw err;
    }

    // 2. 插入示例题
    try {
      await seedProblems();
    } catch (err) {
      console.error("示例题插入失败:", err);
      throw err;
    }

    // 3. 初始化示例分类
    try {
      console.log("初始化示例分类...");
      await seedCategories();
    } catch (err) {
      console.error("示例分类初始化失败:", err);
      throw err;
    }

    // 4. 关联题目与分类
    try {
      console.log("关联题目与分类...");
      await seedProblemCategories();
    } catch (err) {
      console.error("分类关联失败:", err);
      throw err;
    }

    // 5. 管理员创建/提升
    try {
      console.log("检查管理员...");
      await ensureAdminFromEnv();
    } catch (err) {
      console.error("管理员处理失败:", err);
      throw err;
    }

    console.log("Seed 完成");
  } finally {
    // 关闭数据库连接池，确保进程退出
    const { resetDbForTest } = await import("../src/db/connection.ts");
    await resetDbForTest();
  }
}

await main();
