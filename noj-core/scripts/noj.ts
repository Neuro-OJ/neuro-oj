/**
 * Neuro OJ 管理 CLI（Cliffy 单入口）。
 *
 * 用法：
 *   deno task db:migrate         → noj db migrate
 *   deno task init:system        → noj init system
 *   deno task bootstrap:admin    → noj bootstrap admin [--email --password]
 *   deno task problems:build     → noj problems build [--id]
 *   deno task problems:import    → noj problems import [--dir]
 *   deno task dev-setup          → noj dev-setup
 *
 * 取代原 seed.ts / build-packages.ts 脚本（seed 字样已移除）。
 * 统一 --env-file 与错误退出码约定。
 */

import { join } from "jsr:@std/path@^1";
import { Command } from "@cliffy/command";
import { HelpCommand } from "@cliffy/command/help";
import { CompletionsCommand } from "@cliffy/command/completions";
import { runMigrations } from "../src/db/migrate.ts";
import { ensureRootUser } from "../src/domains/identity/index.ts";
import { ensureRbacSeeds } from "../src/services/seed/seed-rbac.ts";
import {
  ensureAdminFromEnv,
  ensureBootstrapAdmin,
  ensureE2EPwChangeUser,
  seedJudgeImages,
  seedLlmQuotas,
  seedTags,
} from "../src/services/seed/seed-system.ts";
import { importProblemBundle } from "../src/services/problems/problem-bundle.ts";
import { isValidTemplateFileName } from "../src/types/problem-bundle.ts";
import { ROOT_USER_ID } from "../src/lib/constants.ts";

const PROJECT_ROOT = Deno.env.get("NOJ_PROJECT_ROOT") ??
  join(import.meta.dirname ?? ".", "..");
const SRC_DIR = join(PROJECT_ROOT, "data", "problems-src");
const OUT_DIR = join(PROJECT_ROOT, "data", "packages");

/**
 * 读取题目 manifest 声明的模板文件名（缺省 "template.py"）。
 *
 * 模板仅供前端编辑器使用，不属于评测内容。打包时需动态排除
 * manifest.template 索引的文件：仅排除字面 `template.py` 会让自定义
 * 模板名（如 starter.py）混入评测包。manifest 缺失/损坏或模板值非法
 * （含 `/`、`\`、`..`，与导入校验规则一致）时回退默认名。
 */
function resolveTemplateExclude(srcDir: string): string {
  let templateFile = "template.py";
  try {
    const manifest = JSON.parse(
      Deno.readTextFileSync(join(srcDir, "problem.json")),
    ) as { template?: unknown };
    const t = manifest.template;
    if (typeof t === "string" && isValidTemplateFileName(t)) {
      templateFile = t;
    }
  } catch {
    // manifest 缺失或损坏：回退默认 template.py
  }
  return templateFile;
}

/**
 * 构建单个题目包（problems-src/<id>/ → packages/<id>.zip）。
 *
 * 排除规则：submission*（参考实现）、manifest.template 模板文件、__pycache__（字节码）、.git。
 */
async function buildProblemPackage(id: string): Promise<void> {
  const srcDir = join(SRC_DIR, id);
  const outFile = join(OUT_DIR, `${id}.zip`);

  // 先删除旧产物：zip -r 对已存在文件是"更新"语义，会保留源中已删除的旧条目
  try {
    await Deno.remove(outFile);
  } catch {
    // 首次构建，文件不存在
  }

  const cmd = new Deno.Command("zip", {
    args: [
      "-r",
      outFile,
      ".",
      "-x",
      "submission*",
      "-x",
      resolveTemplateExclude(srcDir),
      "-x",
      "*__pycache__*",
      "-x",
      ".git/*",
    ],
    cwd: srcDir,
  });

  const { code, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(
      `打包失败 (${id}): ${new TextDecoder().decode(stderr)}`,
    );
  }
  console.log(`  已构建: ${outFile}`);
}

/** 构建全部题目包（problems-src 下所有目录）。 */
async function buildAllPackages(): Promise<void> {
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const ids: string[] = [];
  for await (const entry of Deno.readDir(SRC_DIR)) {
    if (entry.isDirectory) ids.push(entry.name);
  }
  if (ids.length === 0) {
    console.log(`  源目录为空: ${SRC_DIR}，跳过构建`);
    return;
  }
  for (const id of ids) {
    await buildProblemPackage(id);
  }
}

/**
 * 批量导入目录下的统一题目包（默认 data/packages）。
 * 以 root/admin 身份执行（CLI 为运维工具），幂等 upsert。
 */
async function importProblemPackages(dir: string): Promise<void> {
  let imported = 0;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.toLowerCase().endsWith(".zip")) {
        continue;
      }
      const data = await Deno.readFile(join(dir, entry.name));
      await importProblemBundle(
        { name: entry.name, data },
        { userId: ROOT_USER_ID, userRole: "admin" },
      );
      console.log(`  已导入: ${entry.name}`);
      imported++;
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log(`  目录不存在: ${dir}，跳过导入`);
      return;
    }
    throw err;
  }
  if (imported === 0) {
    console.log(`  目录中没有找到统一题目包: ${dir}`);
  }
}

/** 系统基础数据：root + RBAC + 镜像白名单 + 标签（幂等）。 */
async function runInitSystem(): Promise<void> {
  console.log("初始化系统基础数据...");
  await ensureRootUser();
  await ensureRbacSeeds();
  console.log("初始化评测镜像白名单...");
  await seedJudgeImages();
  console.log("初始化种子标签...");
  await seedTags();
  console.log("初始化 LLM 默认配额...");
  await seedLlmQuotas();
  // 注：题目-标签关联由 problems import 按 manifest.tags 完成
  console.log("系统基础数据初始化完成");
}

/** 管理员引导：ADMIN_EMAIL/ADMIN_PASS（env 或 CLI 参数）+ 兜底。 */
async function runBootstrapAdmin(
  opts: { email?: string; password?: string },
): Promise<void> {
  if (opts.email) Deno.env.set("ADMIN_EMAIL", opts.email);
  if (opts.password) Deno.env.set("ADMIN_PASS", opts.password);
  console.log("检查管理员...");
  await ensureAdminFromEnv();
  await ensureBootstrapAdmin();
}

/** 开发环境一键初始化（含 dev 专用数据：E2E 守卫用户）。 */
async function runDevSetup(): Promise<void> {
  console.log("=".repeat(48));
  console.log("dev-setup：开发环境一键初始化");
  console.log("=".repeat(48));

  console.log("\n[1/5] 数据库迁移");
  await runMigrations();

  console.log("\n[2/5] 系统基础数据");
  await runInitSystem();

  console.log("\n[3/5] 管理员引导");
  await runBootstrapAdmin({});

  console.log("\n[4/5] 构建题目包");
  await buildAllPackages();

  console.log("\n[5/5] 导入题目包 + dev 专用数据");
  await importProblemPackages(OUT_DIR);
  await ensureE2EPwChangeUser();

  console.log("\ndev-setup 完成");
}

// ── 子命令定义（Cliffy 嵌套：命令实例挂载）────────────────

const dbCmd = new Command()
  .description("数据库操作")
  .command("migrate", "执行数据库迁移")
  .action(() => {
    return runMigrations();
  });

const initCmd = new Command()
  .description("系统初始化")
  .command("system", "初始化系统基础数据（root + RBAC + 镜像白名单 + 标签）")
  .action(() => {
    return runInitSystem();
  });

const bootstrapCmd = new Command()
  .description("管理员引导")
  .command("admin", "创建/引导管理员（env 或 CLI 参数）")
  .option("--email <email:string>", "管理员邮箱")
  .option("--password <password:string>", "管理员密码")
  .action((opts: { email?: string; password?: string }) => {
    return runBootstrapAdmin(opts);
  });

const problemsCmd = new Command()
  .description("题目包操作")
  .command("build", "从 data/problems-src 构建统一题目包")
  .option("--id <id:string>", "仅构建指定题目 id")
  .action(async (opts: { id?: string }) => {
    if (opts.id) {
      await buildProblemPackage(opts.id);
    } else {
      await buildAllPackages();
    }
  })
  .command("import", "批量导入统一题目包（幂等 upsert）")
  .option("--dir <dir:string>", "题目包目录", { default: OUT_DIR })
  .action((opts: { dir: string }) => {
    return importProblemPackages(opts.dir);
  });

try {
  await new Command()
    .name("noj")
    .description("Neuro OJ 管理 CLI（迁移、初始化、管理员、题目包）")
    .version("1.0.0")
    .command("db", dbCmd)
    .command("init", initCmd)
    .command("bootstrap", bootstrapCmd)
    .command("problems", problemsCmd)
    .command("dev-setup", "开发环境一键初始化（含 dev 专用数据）")
    .action(() => {
      return runDevSetup();
    })
    .command("help", new HelpCommand().global())
    .command("completions", new CompletionsCommand())
    .parse(Deno.args);
} catch (err) {
  // 错误不得被吞：打印错误信息并以非零码退出（此前 finally exit(0)
  // 会让 problems build / dev-setup 等失败时静默"成功"，误导 CI）。
  const msg = err instanceof Error ? err.message : String(err);
  if (msg) console.error(`noj: ${msg}`);
  Deno.exit(1);
}
// 强制退出：postgres.js 连接会阻止进程自然终止（同 migrate.ts 处理）
Deno.exit(0);
