/**
 * 系统初始化数据（原 scripts/seed.ts 拆分）。
 *
 * 供 CLI（scripts/noj.ts）子命令复用：
 * - `init system`：root 用户 + 镜像白名单 + 标签
 * - `bootstrap admin`：管理员引导
 * - `dev-setup`：额外填充 dev 专用数据（E2E 守卫用户）
 *
 * 授权事实只有 `users.role`；不再写入任何角色/权限关联表。
 *
 * 全部幂等（ON CONFLICT DO NOTHING / 存在性检查）。
 */

import { eq, sql } from "drizzle-orm";
import { basename, dirname, extname, join, resolve } from "jsr:@std/path@^1";
import { getDb } from "../../../../../shared/db/connection.ts";
import { enqueueSearchIndexTask } from "../../../../application/search-tasks.ts";
import { judgeImages, tags, users } from "../../../../../shared/db/schema.ts";
import { hashPassword } from "../../../../access/contracts/cross-module/identity_services_security_password.ts";
import { ROOT_USER_ID } from "../../../../../shared/base/constants.ts";
import {
  getAdminUserIds,
  isUserAdmin,
} from "../../../../access/contracts/cross-module/identity_services_security_permissions.ts";

/**
 * 把既有账号提升为平台管理员（单值写入 `users.role`）。
 *
 * 幂等：写入同一角色不会产生额外副作用；不再创建角色行或关联记录。
 */
async function promoteToPlatformAdmin(userId: string): Promise<void> {
  await getDb().update(users).set({
    role: "admin",
    updated_at: new Date().toISOString(),
  }).where(eq(users.id, userId));
}

/**
 * 引导管理员是否强制首次改密（issue #75 守卫）。
 *
 * 默认 true（生产安全基线）；devtool 的 `bootstrap admin` 子命令会设置
 * `NOJ_FORCE_PASSWORD_CHANGE=false`，使开发环境管理员首次登录即可使用完整功能。
 */
function shouldForcePasswordChange(): boolean {
  return Deno.env.get("NOJ_FORCE_PASSWORD_CHANGE") !== "false";
}

/** 引导凭据默认落盘路径（相对启动目录，`.data/` 已被 .gitignore 忽略）。 */
const BOOTSTRAP_CREDENTIAL_RELATIVE_PATH = ".data/bootstrap-admin.txt";

/** 凭据文件写入结果。 */
export interface BootstrapCredentialsWriteResult {
  /** 实际写入的绝对路径（目标已存在时为另存的兄弟文件）。 */
  filePath: string;
  /** 调用方请求的目标绝对路径。 */
  requestedPath: string;
  /** 目标已存在且未被覆盖（本次写到了兄弟文件）。 */
  existingPreserved: boolean;
}

/** 解析凭据落盘路径；相对路径以启动目录为基准，便于注入临时目录/挂载点。 */
export function resolveBootstrapCredentialsPath(filePath?: string): string {
  const configured = filePath?.trim();
  return resolve(
    Deno.cwd(),
    configured || BOOTSTRAP_CREDENTIAL_RELATIVE_PATH,
  );
}

/** 目标已存在时生成不冲突的兄弟文件名（时间戳 + 随机后缀）。 */
function bootstrapCredentialsSibling(filePath: string): string {
  const extension = extname(filePath);
  const stem = basename(filePath, extension);
  // 2026-11-22T02:40:00.123Z → 20261122T024000123Z
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const nonce = crypto.getRandomValues(new Uint8Array(4))
    .reduce((out, byte) => out + byte.toString(16).padStart(2, "0"), "");
  return join(dirname(filePath), `${stem}-${stamp}-${nonce}${extension}`);
}

/**
 * 把一次性引导凭据写入本机文件。
 *
 * 密码不进日志 sink：控制台只给路径，避免终端回滚、录屏或日志采集把临时凭据
 * 带走。文件权限尽力设为 0600（Windows 无 POSIX 权限位，忽略即可）。
 *
 * 不静默覆盖：目标文件已存在时改写到同目录下带时间戳的兄弟文件，既有凭据
 * 原样保留；返回值携带实际路径与是否发生旁路，调用方据此提示操作者。
 *
 * @param credentials 一次性凭据
 * @param filePath 目标路径；相对路径以启动目录为基准，省略时用
 *   `.data/bootstrap-admin.txt`
 */
export async function writeBootstrapCredentialsFile(
  credentials: { username: string; email: string; password: string },
  filePath?: string,
): Promise<BootstrapCredentialsWriteResult> {
  const requestedPath = resolveBootstrapCredentialsPath(filePath);
  const content = [
    "# NOJ 引导管理员一次性凭据",
    `timestamp: ${new Date().toISOString()}`,
    `username: ${credentials.username}`,
    `email: ${credentials.email}`,
    `password: ${credentials.password}`,
    "",
    "首次登录后系统会强制要求修改密码；确认可登录后请删除本文件。",
    "",
  ].join("\n");
  try {
    await Deno.mkdir(dirname(requestedPath), {
      recursive: true,
      mode: 0o700,
    });
    let target = requestedPath;
    let existingPreserved = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await Deno.writeTextFile(target, content, {
          createNew: true,
          mode: 0o600,
        });
        return { filePath: target, requestedPath, existingPreserved };
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
        existingPreserved = true;
        target = bootstrapCredentialsSibling(requestedPath);
      }
    }
    throw new Error("连续生成兄弟文件名仍冲突");
  } catch (error) {
    throw new Error(
      `引导凭据写入失败：${requestedPath}（${
        error instanceof Error ? error.message : String(error)
      }）。请确认该目录可写；只读根文件系统请用 bootstrap admin --credentials-file 指定挂载的可写目录`,
      { cause: error },
    );
  }
}

/**
 * 初始化评测镜像白名单。
 * 仅保留双容器镜像（noj-evaluator-python / noj-solution-python）。
 * 幂等：使用固定 UUID 确保重复运行不重复插入。
 */
export async function seedJudgeImages(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  // 生产环境通过 JUDGE_IMAGE_BASE 指定 ghcr 仓库前缀（如 ghcr.io/neuro-oj/），
  // 使白名单写入 ghcr 全限定镜像名；未设置时保持本地开发默认名。
  const imageBase = (Deno.env.get("JUDGE_IMAGE_BASE") ?? "").replace(
    /\/+$/,
    "",
  );
  const withBase = (name: string) => imageBase ? `${imageBase}/${name}` : name;

  const images = [
    {
      id: "e0000000-0000-0000-0000-000000000002",
      image: withBase("noj-evaluator-python"),
      mode: "all_versions",
      kind: "evaluator",
      description: "双容器 Evaluator (Python 3.12, noj_evaluator_sdk)",
    },
    {
      id: "e0000000-0000-0000-0000-000000000003",
      image: withBase("noj-solution-python"),
      mode: "all_versions",
      kind: "solution",
      description: "双容器 Solution (Python 3.12, noj_solution_sdk)",
    },
    {
      id: "e0000000-0000-0000-0000-000000000004",
      image: withBase("noj-solution-ai"),
      mode: "all_versions",
      kind: "solution",
      description: "双容器 Solution AI (Python 3.12, CPU torch, CV/ML 库)",
    },
  ];

  // 三条镜像一次批量 upsert（P3）：冲突时按 id 更新 kind/mode/description，
  // 刻意不写 image —— 运维手工改过的镜像名不被种子覆盖。
  await db.insert(judgeImages).values(
    images.map((img) => ({
      ...img,
      created_at: now,
      updated_at: now,
    })),
  ).onConflictDoUpdate({
    target: judgeImages.id,
    set: {
      kind: sql`excluded.kind`,
      mode: sql`excluded.mode`,
      description: sql`excluded.description`,
      updated_at: sql`excluded.updated_at`,
    },
  });
  for (const img of images) {
    console.log(`  已同步评测镜像: ${img.image} (kind=${img.kind})`);
  }
}

/**
 * 初始化种子标签（issue #223：category 系统退役，双类标签取代）。
 */
export async function seedTags(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  const seed = [
    // 题目标签（人人可见）
    { id: "tag-lmcc", name: "LMCC 样例题", kind: "problem" },
    { id: "tag-beginner", name: "入门", kind: "problem" },
    // 算法标签（通过题目后可见）
    { id: "tag-simulate", name: "模拟", kind: "algorithm" },
    { id: "tag-sliding-window", name: "滑动窗口", kind: "algorithm" },
    { id: "tag-prefix-sum", name: "前缀和", kind: "algorithm" },
    { id: "tag-graph", name: "图论", kind: "algorithm" },
    { id: "tag-dp", name: "DP", kind: "algorithm" },
    { id: "tag-ds", name: "数据结构", kind: "algorithm" },
    { id: "tag-tree", name: "树", kind: "algorithm" },
  ];

  for (const tag of seed) {
    // 以 name 为幂等键：运营者若已手工创建同名标签（随机 UUID），
    // 种子跳过而不触发 name UNIQUE 冲突（语义上 name 才是标签身份）。
    await db
      .insert(tags)
      .values({ ...tag, created_at: now, updated_at: now })
      .onConflictDoNothing({ target: tags.name });
    console.log(`  已同步标签: ${tag.name} (${tag.kind})`);
  }
}

/**
 * 根据 ADMIN_EMAIL 环境变量创建/提升管理员。
 *
 * ADMIN_EMAIL 必须设置。
 * 若 ADMIN_PASS 同时设置，则自动创建用户（不存在时）并设为 admin；
 * 若 ADMIN_PASS 未设置，则仅提升已存在的用户。
 */
export async function ensureAdminFromEnv(): Promise<void> {
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
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const username = adminEmail.split("@")[0].replace(
      /[^a-zA-Z0-9_]/g,
      "_",
    );

    await db.insert(users).values({
      id,
      username,
      email: adminEmail,
      password_hash: await hashPassword(adminPass),
      must_change_password: shouldForcePasswordChange(),
      role: "admin",
      created_at: now,
      updated_at: now,
    });
    await enqueueSearchIndexTask("user", id, "upsert");
    const guard = shouldForcePasswordChange()
      ? "已强制首次改密"
      : "开发模式：未强制首次改密";
    console.log(
      `  已创建管理员用户: ${adminEmail} (${username})，${guard}`,
    );
    return;
  }

  const user = existing[0];
  // 幂等判断：用户平台角色已是 admin 则跳过
  if (await isUserAdmin(user.id)) {
    console.log(`  用户 ${adminEmail} 已是管理员，无需提升`);
    return;
  }

  await promoteToPlatformAdmin(user.id);
  console.log(`  已提升用户 ${adminEmail} 为管理员`);
}

/**
 * 生成 24 字符 base64url 强随机密码（issue #75，评审修复 M4）。
 *
 * base64url 字符集 [A-Za-z0-9_-] 共 64 字符，每字符 6 bits 熵。
 * 24 字符 × 6 bits = 144 bits 熵，满足 NIST SP 800-63B 临时凭证要求。
 */
function generateStrongPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
    .slice(0, 24);
}

/**
 * 引导管理员兜底（issue #75）。
 *
 * 当系统中不存在任何可登录管理员（users.role='admin' 且 id!='0'）时，
 * 自动创建一个临时管理员（username=admin / email=admin@noj.local /
 * 24 字符随机密码，must_change_password=true），凭据写入启动目录的
 * `.data/bootstrap-admin.txt`，终端只打印文件路径。
 * 已存在可登录 admin 时本函数为 no-op，可重复运行（幂等）。
 *
 * 顺序：**先交付凭据、后落库**。凭据写盘失败时抛错（CLI 非零退出），此时
 * 数据库里没有管理员，`hasLoginableAdmin` 不会挡住修好目录后的重跑；反过来
 * （先落库、失败再删号）依赖第二次数据库写成功，数据库不健康时会留下一个
 * 没有密码的管理员，反而把初始化锁死。
 *
 * @param options.credentialsFile 凭据落盘路径；相对路径以启动目录为基准，
 *   省略时用 `.data/bootstrap-admin.txt`。只读根文件系统（生产 `core` 容器）
 *   里应指向挂载的可写目录。
 */
export async function ensureBootstrapAdmin(
  options: { credentialsFile?: string } = {},
): Promise<void> {
  if (Deno.env.get("ADMIN_EMAIL")) {
    console.log(
      "  ADMIN_EMAIL 已设置，遵循环境变量配置，跳过引导管理员创建",
    );
    return;
  }

  const db = getDb();

  // 存在可登录管理员（users.role='admin'，排除 root）则跳过
  const adminIds = await getAdminUserIds();
  const hasLoginableAdmin = [...adminIds].some((id) => id !== ROOT_USER_ID);
  if (hasLoginableAdmin) {
    console.log("  已存在可登录管理员，跳过引导管理员创建");
    return;
  }

  const username = "admin";
  const email = "admin@noj.local";
  const password = generateStrongPassword();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);

  // 1) 先交付一次性凭据；失败即中止，数据库尚未发生任何写入。
  let credentialFile: string;
  try {
    const written = await writeBootstrapCredentialsFile(
      { username, email, password },
      options.credentialsFile,
    );
    credentialFile = written.filePath;
    if (written.existingPreserved) {
      console.warn(
        `  目标 ${written.requestedPath} 已存在，未覆盖；本次凭据写入 ${written.filePath}`,
      );
    }
  } catch (error) {
    // 一次性密码不送进日志：只报路径/原因，绝不回落为打印密码。
    throw new Error(
      "引导管理员创建已中止：一次性凭据写盘失败，未创建任何管理员账号。" +
        "修复目录后可直接重跑（会生成新密码）。" +
        (error instanceof Error ? ` 原因：${error.message}` : ""),
      { cause: error },
    );
  }

  // 2) 凭据已交付，再落库。插入失败时保留凭据文件而不删除：若提交结果
  // 不确定（连接在响应途中断开），文件里的密码仍可能对应已建账号；重跑时
  // 已存在管理员会走幂等跳过，不会覆盖该文件。
  try {
    await db.insert(users).values({
      id,
      username,
      email,
      password_hash: passwordHash,
      must_change_password: shouldForcePasswordChange(),
      role: "admin",
      created_at: now,
      updated_at: now,
    });
  } catch (error) {
    throw new Error(
      `引导管理员账号创建失败；本次凭据保留在 ${credentialFile}，` +
        "如确认账号未创建可直接重跑（会另存新文件，不覆盖该文件）。" +
        (error instanceof Error ? ` 原因：${error.message}` : ""),
      { cause: error },
    );
  }

  console.log("");
  console.log("-".repeat(72));
  if (shouldForcePasswordChange()) {
    console.log("⚠ 已创建临时引导管理员（首次登录后必须修改密码）");
  } else {
    console.log(
      "✓ 已创建开发引导管理员（未强制首次改密，可直接使用完整功能）",
    );
  }
  console.log("-".repeat(72));
  console.log(`  username: ${username}`);
  console.log(`  email:    ${email}`);
  console.log(`  已写入 ${credentialFile}，请打开查看`);
  console.log("-".repeat(72));
  if (shouldForcePasswordChange()) {
    console.log(
      "⚠ 请立即查看上述密码文件，首次登录后系统会强制要求修改密码。",
    );
  }
  console.log("-".repeat(72));
  console.log("");
}

/**
 * 创建 E2E 守卫测试专用用户（must_change_password=true）。
 *
 * 仅在 NOJ_RUN_E2E=1 时创建，供 noj-tests/e2e/identity/password_change_guard.test.ts
 * 验证 PASSWORD_CHANGE_REQUIRED 守卫（评审修复 H2）。
 * 幂等：用户存在时跳过。
 */
export async function ensureE2EPwChangeUser(): Promise<void> {
  if (Deno.env.get("NOJ_RUN_E2E") !== "1") return;

  const email = "e2e_pwchange@test.com";
  const pass = "e2e_pwchange_pass_8chars";
  const db = getDb();

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length > 0) {
    console.log(`  E2E 守卫测试用户 ${email} 已存在，跳过创建`);
    return;
  }

  const now = new Date().toISOString();
  await db.insert(users).values({
    id: crypto.randomUUID(),
    username: "e2e_pwchange",
    email,
    password_hash: await hashPassword(pass),
    must_change_password: true,
    created_at: now,
    updated_at: now,
  });
  console.log(
    `  已创建 E2E 守卫测试用户: ${email} (must_change_password=true)`,
  );
}
