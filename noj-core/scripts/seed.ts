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

import { and, eq, not, sql } from "drizzle-orm";
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
  number: number;
  owner_id: string;
  type: string;
}

const SAMPLE_PROBLEMS: SampleProblem[] = [
  {
    id: "1001",
    title: "1001 T0-LMCC：星港舱门报码归一化",
    description: "## 问题背景\n\n星港空间站的多传感器系统会采集大量环境数据。" +
      "其中，**舱门报码归一化**任务要求将自然语言描述的报码整理成标准 JSON 格式。\n\n" +
      "## 输入格式\n\n输入包含一个字符串 `report`，描述舱门状态，例如：\n\n" +
      '```json\n{"gate": "A12", "status": "open", "timestamp": 1704067200}\n```\n\n' +
      "## 输出要求\n\n输出标准化的 JSON，包含以下字段：\n\n" +
      "- `gate_id` (`string`) — 舱门编号\n" +
      "- `status` (`string`) — 舱门状态（`open` / `closed` / `maintenance`）\n\n" +
      "## 评分标准\n\n总分 10 分。评测时使用公式：\n\n" +
      "$$ \\text{score} = \\frac{\\text{正确字段数}}{\\text{总字段数}} \\times 10 $$\n\n" +
      "其中 $\\text{正确字段数}$ 由评测脚本根据标准答案计算。\n\n" +
      "## 示例\n\n### 示例 1\n\n**输入**\n\n" +
      '```\n舱门 A12 已打开\n```\n\n**输出**\n\n```json\n{"gate_id": "A12", "status": "open"}\n```\n\n' +
      "> 注意：输出的 JSON 键名使用 `snake_case`。\n\n" +
      "### 示例 2\n\n**输入**\n\n" +
      '```\nB-07 舱门维护中\n```\n\n**输出**\n\n```json\n{"gate_id": "B-07", "status": "maintenance"}\n```',
    difficulty: "easy",
    judge_image: "noj-judge-python",
    judge_command: "python3 /tmp/evaluate.py",
    support_package_path: "data/packages/1001.zip",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
    number: 1001,
    owner_id: "0",
    type: "P",
  },
  {
    id: "1002",
    title: "1002 T0-LMCC：传感器数据滤波",
    description:
      "## 问题描述\n\n给定一个长度为 $n$ 的整数数组 $\\text{sensor\\_data}$，" +
      "使用**滑动窗口平均法**对数据进行平滑滤波。窗口大小为 $k$。\n\n" +
      "## 公式\n\n滤波后的第 $i$ 个元素为：\n\n" +
      "$$ \\text{filtered}[i] = \\frac{1}{k} \\sum_{j=i}^{i+k-1} \\text{sensor\\_data}[j] $$\n\n" +
      "其中 $0 \\leq i \\leq n-k$。\n\n" +
      "## 输入\n\n- 第一行：$n$ 和 $k$（空格分隔）\n- 第二行：$n$ 个整数，即 $\\text{sensor\\_data}$\n\n" +
      "## 输出\n\n一行，$n-k+1$ 个浮点数（保留两位小数），空格分隔。\n\n" +
      "## 示例\n\n**输入**\n\n```\n6 3\n1 3 5 7 9 11\n```\n\n**输出**\n\n```\n3.00 5.00 7.00 9.00\n```\n\n" +
      "## 限制\n\n- $1 \\leq k \\leq n \\leq 10^5$\n- $-10^9 \\leq \\text{sensor\\_data}[i] \\leq 10^9$\n- 时间限制：$1000\\text{ms}$\n- 内存限制：$256\\text{MB}$",
    difficulty: "medium",
    judge_image: "noj-judge-python",
    judge_command: "python3 /tmp/evaluate.py",
    support_package_path: null, // TODO: 创建 1002 支持包后更新此路径（deno task build-packages + seed）
    time_limit_ms: 1000,
    memory_limit_mb: 256,
    number: 1002,
    owner_id: "0",
    type: "P",
  },
  {
    id: "1003",
    title: "1003 T0-LMCC：A+B Problem",
    description: "## 问题描述\n\n给定两个整数 $a$ 和 $b$，计算它们的和。\n\n" +
      "## 输入格式\n\n一行，两个整数 $a$ 和 $b$，空格分隔。\n\n" +
      "## 输出格式\n\n一行，一个整数，即 $a + b$ 的值。\n\n" +
      "## 示例\n\n**输入**\n\n```\n1 2\n```\n\n**输出**\n\n```\n3\n```\n\n" +
      "## 限制\n\n- $-10^9 \\leq a, b \\leq 10^9$\n- 时间限制：$1000\\text{ms}$\n- 内存限制：$256\\text{MB}$",
    difficulty: "easy",
    judge_image: "noj-judge-python",
    judge_command: "python3 /tmp/evaluate.py",
    support_package_path: "data/packages/1003.zip",
    time_limit_ms: 1000,
    memory_limit_mb: 256,
    number: 1003,
    owner_id: "0",
    type: "P",
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
  ["1003", "cat-algorithm"],
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
 *
 * 注意：环境变量创建的初始密码视为临时凭证，置 must_change_password=true，
 * 强制首次登录后修改。
 */
async function ensureAdminFromEnv(): Promise<void> {
  const adminEmail = Deno.env.get("ADMIN_EMAIL");
  if (!adminEmail) {
    console.log("  ADMIN_EMAIL 未设置，将进入引导管理员兜底流程");
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
      must_change_password: true,
      created_at: now,
      updated_at: now,
    });
    console.log(
      `  已创建管理员用户: ${adminEmail} (${username})，已强制首次改密`,
    );
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

/**
 * 生成 24 字符 base64url 强随机密码（issue #75）。
 *
 * base64url 字符集为 [A-Za-z0-9_-]，24 字符提供 ~144 bits 熵。
 * 替换 +/= 等 URL 不安全字符，并去除易混淆字符（i/l/O/0）。
 */
function generateStrongPassword(): string {
  const bytes = new Uint8Array(18); // 18 bytes → 24 chars base64url
  crypto.getRandomValues(bytes);
  let raw = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  // 去除易混淆字符（i, l, O, 0, 1），避免控制台抄写错误
  raw = raw.replace(/[iIlO01]/g, "");
  return raw.slice(0, 24).padEnd(24, "X");
}

/**
 * 引导管理员兜底（issue #75）。
 *
 * 当系统中不存在任何可登录管理员（role='admin' AND id!='0'）时，
 * 自动创建一个临时管理员：
 *   - username: admin
 *   - email:    admin@noj.local
 *   - password: 24 字符 base64url 随机
 *   - must_change_password: true
 *
 * 凭据以醒目块打印到终端，强制运维立即记录并首次登录后修改。
 * 已存在可登录 admin 时本函数为 no-op，可重复运行（幂等）。
 */
async function ensureBootstrapAdmin(): Promise<void> {
  const db = getDb();

  const [adminCountRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .where(and(eq(users.role, "admin"), not(eq(users.id, "0"))));
  const adminCount = Number(adminCountRow?.count ?? 0);
  if (adminCount > 0) {
    console.log("  已存在可登录管理员，跳过引导管理员创建");
    return;
  }

  const username = "admin";
  const email = "admin@noj.local";
  const password = generateStrongPassword();
  const { hashPassword } = await import("../src/lib/password.ts");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(users).values({
    id,
    username,
    email,
    password_hash: await hashPassword(password),
    role: "admin",
    must_change_password: true,
    created_at: now,
    updated_at: now,
  });

  console.log("");
  console.log("-".repeat(72));
  console.log("⚠ 已创建临时引导管理员（首次登录后必须修改密码）");
  console.log("-".repeat(72));
  console.log(`  username: ${username}`);
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log("-".repeat(72));
  console.log("⚠ 请立即记录上述密码，首次登录后系统会强制要求修改密码。");
  console.log("-".repeat(72));
  console.log("");
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

    // 2. 确保 root 系统用户存在（problems.owner_id FK 依赖）
    try {
      const { ensureRootUser } = await import("../src/services/auth.ts");
      await ensureRootUser();
    } catch (err) {
      console.error("Root 用户初始化失败:", err);
      throw err;
    }

    // 3. 插入示例题
    try {
      await seedProblems();
    } catch (err) {
      console.error("示例题插入失败:", err);
      throw err;
    }

    // 4. 初始化示例分类
    try {
      console.log("初始化示例分类...");
      await seedCategories();
    } catch (err) {
      console.error("示例分类初始化失败:", err);
      throw err;
    }

    // 5. 关联题目与分类
    try {
      console.log("关联题目与分类...");
      await seedProblemCategories();
    } catch (err) {
      console.error("分类关联失败:", err);
      throw err;
    }

    // 6. 管理员创建/提升（环境变量优先）
    try {
      console.log("检查管理员...");
      await ensureAdminFromEnv();
    } catch (err) {
      console.error("管理员处理失败:", err);
      throw err;
    }

    // 7. 引导管理员兜底：无任何可登录 admin 时创建临时账户（issue #75）
    try {
      await ensureBootstrapAdmin();
    } catch (err) {
      console.error("引导管理员创建失败:", err);
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
