/**
 * 恢复演练业务验收的**真实 HTTP 契约** E2E（rc/v0.11 修复计划 W3 最后一条验收项）。
 *
 * ## 为什么需要这一层（审计 F3）
 *
 * 演练的验收逻辑（`noj-cli/src/prod/drill/verify.ts`）此前调用的是**已删除**的
 * 无域接口 `POST /api/v1/problems/import-bundle`（真实 core 返回 404），而 CLI 的
 * 825 个单测因为 mock 与真实契约脱节**全部通过**——mock 里怎么拼 URL 都对，
 * 真实 core 只认域入口。修复后演练改走
 * `noj-cli/src/problem/client.ts`（路径唯一来源），并在 CLI 侧补了 mock 级的
 * “请求路径白名单”断言；**缺的正是本文件提供的证据**：让演练客户端对着一个真实
 * 启动的 core 跑一遍，HTTP 请求真实落到 `/api/v1/domains/main/problems`。
 *
 * 本测试因此刻意**不做任何 mock**：
 * 1. 在一个**独立数据库**上跑真实迁移 + 系统初始化（root/RBAC/main 域）；
 * 2. 用 `Deno.Command` 真启 `noj-core`（真实 PG + 真实 Redis），轮询 `/health/ready`；
 * 3. 用子进程 `deno eval`（cwd = `noj-cli`，`--config deno.json` 让裸标识符按 CLI 的
 *    import map 解析）调用 `runBusinessVerification({ skipEvaluation: true })`，
 *    并用**记录型 fetch 包装真实 fetch**，把演练实际发出的每个请求（方法/URL/状态码）
 *    带回来断言；
 * 4. 与演练解耦地再探一次契约面：旧接口必须 404、域入口必须存在、域列表必须 200。
 *
 * ## 为什么不直接 import 被测模块
 *
 * `noj-tests/deno.json` 的 `imports` 为空，直接 `import "../../../noj-cli/src/..."` 会
 * 因为 `fflate` / `@std/path` 等裸标识符无法解析而失败。子进程 + 各自的 `deno.json`
 * 是唯一稳定的编排方式，也正好让被测方以**生产形态**（CLI 自己的依赖图）运行。
 *
 * ## 前置条件（本机 E2E 栈，缺失则跳过而不是失败）
 *
 * - `NOJ_RUN_E2E=1`（否则整条用例静态 ignore）；
 * - `docker` CLI 可用，且容器 `noj-e2e-postgres`（`postgres://e2e:e2e@127.0.0.1:5433/postgres`）
 *   与 `noj-e2e-redis`（`redis://127.0.0.1:6380`，默认使用独立 db index 隔离队列残留）
 *   在线——建库/删库都经 `docker exec ... psql`，因此没有 docker 就直接跳过；
 * - `deno` 在 PATH；`noj-core` / `noj-cli` 的依赖已缓存（本仓库日常开发/CI 状态）。
 *
 * 可覆盖的环境变量：`DRILL_E2E_PG_ADMIN_URL`、`DRILL_E2E_PG_CONTAINER`、
 * `DRILL_E2E_PG_USER`、`DRILL_E2E_REDIS_URL`、`DRILL_E2E_REDIS_CONTAINER`；
 * `DRILL_E2E_FORCE_DRILL_ADMIN=1` 可强制走“演练 SQL 管理员”分支（跳过 HTTP 注册）。
 *
 * ## 隔离与清理
 *
 * - 数据库名 `noj_drill_e2e_<随机后缀>`，与 `e2e` / 开发库 / 其他测试完全隔离；
 * - 本地对象存储目录用 `Deno.makeTempDir`，不写 `noj-core/data/storage`；
 * - `finally` 里必做三件事：停 core（SIGTERM → 超时补 SIGKILL）、
 *   `DROP DATABASE ... WITH (FORCE)`、删临时存储目录。**无论成败都执行**。
 *
 * ## 账号策略
 *
 * 优先用真实 HTTP 注册一个随机账号（不写库）；注册被关闭（邮件未配置）或该账号
 * 读不到 `main` 域题目列表时，回退到**生产演练同款 SQL**写入 `drill_admin`
 * （`noj-cli/src/prod/drill/drill.ts` 的 `seedDrillAdmin()`：固定 bcrypt 哈希 +
 * `admin` 角色）。已在两种路径下都真跑通过。
 *
 * ## 断言（§验收）
 *
 * - `result.passed === true`、`firstFailure === null`；
 * - `login` / `problem_read` / `register_probe` 三步都存在且**不是** `failed`；
 * - 契约面（对账）：`register_probe` 的结论必须与真实 `POST /auth/register` 的
 *   状态码自洽（201 ⇔ passed），`login` 必须有真实 200——单看 status 字段不够，
 *   F3 的症结正是“字段好看、真实请求不对”；
 * - 契约面（路径）：步骤文案与真实请求里都不得出现**无域前缀**的旧接口片段
 *   （`/problems/import-bundle`、`/self-tests` 等）；真实请求只允许落在
 *   `/api/v1/auth/{login,register}` 与 `/api/v1/domains/main/problems/**`，
 *   且必须至少有一次 `GET /api/v1/domains/main/problems` 200；
 * - 与演练解耦的探针：`POST /api/v1/problems/import-bundle` → 404（F3 的原始 bug 面），
 *   `POST /api/v1/domains/main/problems/import-bundle` → 401/403（路由存在，仅缺认证）。
 *
 * 测试自带完整子进程编排，约 10–20s 结束（迁移 ~2s、init ~1s、core 就绪 ~5s）。
 */

// ── 运行开关（与 noj-tests/e2e/helper.ts 的 isE2E 同款语义）──────────────────

/** 只有显式开启 E2E 才执行：`NOJ_RUN_E2E=1 deno test ...`。 */
const isE2E = Deno.env.get("NOJ_RUN_E2E") === "1";

// ── 仓库内路径（本文件位于 <repo>/noj-tests/e2e/cross-domain/）────────────────

/** 本测试文件所在目录的绝对路径。 */
const HERE = import.meta.dirname;
/** 仓库根目录。 */
const REPO_ROOT = `${HERE}/../../..`;
/** noj-core 源码目录（子进程 cwd）。 */
const CORE_DIR = `${REPO_ROOT}/noj-core`;
/** noj-cli 源码目录（子进程 cwd，裸标识符按它的 import map 解析）。 */
const CLI_DIR = `${REPO_ROOT}/noj-cli`;
/** CLI 的 deno.json（提供 fflate / @std/path 的映射）。 */
const CLI_CONFIG_PATH = `${CLI_DIR}/deno.json`;
/** 被测模块的绝对 file:// URL（跨包 import 不可用，只能由子进程动态 import）。 */
const VERIFY_MODULE_URL = new URL(
  "../../../noj-cli/src/prod/drill/verify.ts",
  import.meta.url,
).href;

// ── 演练契约常量（与 noj-cli/src/prod/drill/plan.ts 对齐）────────────────────
//
// 这些常量在 CLI 侧有唯一定义；noj-tests 无法跨包 import，只能复制一份。
// 复制是刻意的：一旦 plan.ts 改了账号/口令/哈希而这里没跟上，测试会以
// “登录失败”直接暴露，而不是静默漂移。

/** 演练固定管理员用户名。 */
const DRILL_ADMIN_USER = "drill_admin";
/** 演练固定管理员口令。 */
const DRILL_ADMIN_PASSWORD = "Drill-Recover-2026";
/** 演练固定管理员 bcrypt 哈希（cost 12，与 plan.ts 逐字一致）。 */
const DRILL_BCRYPT_HASH =
  "$2b$12$edDmxsubnHJL8B/Wsdryxu4ibNin0/SEhqAXkB.Yn50SCoN29lQCW";
/** 演练管理员邮箱域（`.invalid` 保证不可达）。 */
const DRILL_ADMIN_EMAIL_DOMAIN = "restore-drill.invalid";
/** 演练目标工作空间（0.11 起题目只存在于域内，main 由系统初始化创建）。 */
const DOMAIN = "main";

// ── 隔离资源参数（可用环境变量覆盖）──────────────────────────────────────────

/** PG 管理连接串（必须带 admin 库名；测试在这里建/删隔离库）。 */
const PG_ADMIN_URL = Deno.env.get("DRILL_E2E_PG_ADMIN_URL") ??
  "postgres://e2e:e2e@127.0.0.1:5433/postgres";
/** PG 容器名（psql 只存在于容器里）。 */
const PG_CONTAINER = Deno.env.get("DRILL_E2E_PG_CONTAINER") ??
  Deno.env.get("E2E_POSTGRES_CONTAINER") ?? "noj-e2e-postgres";
/** PG 用户。 */
const PG_USER = Deno.env.get("DRILL_E2E_PG_USER") ?? "e2e";
/** psql 建库/删库时使用的管理库名。 */
const PG_ADMIN_DATABASE = "postgres";
/** Redis 容器名（仅用于前置探测）。 */
const REDIS_CONTAINER = Deno.env.get("DRILL_E2E_REDIS_CONTAINER") ??
  Deno.env.get("E2E_REDIS_CONTAINER") ?? "noj-e2e-redis";
/**
 * Redis 连接串。
 *
 * 默认落在独立 db index（9–15 随机）而不是 `/0`：`/0` 上常驻其他 E2E 轮次遗留的
 * 评测队列残留，会让 core 的消费者反复报“结果 JSON 解析失败”并刷满日志尾部，
 * 干扰失败归因。真正的业务队列键在 core 内部按前缀区分，换 index 只影响隔离性。
 */
const REDIS_URL = Deno.env.get("DRILL_E2E_REDIS_URL") ??
  `redis://127.0.0.1:6380/${9 + Math.floor(Math.random() * 7)}`;

/** core 就绪等待上限（冷启动 + 依赖探测；本机实测 ~5s）。 */
const CORE_READY_TIMEOUT_MS = 120_000;
/** 单次健康探测超时。 */
const HEALTH_PROBE_TIMEOUT_MS = 3_000;
/** core 优雅停机等待上限，超时补 SIGKILL。 */
const CORE_STOP_TIMEOUT_MS = 20_000;
/**
 * 强制走“生产同款 SQL 管理员”分支（跳过 HTTP 注册）。
 *
 * `NOJ_RUN_E2E=1 DRILL_E2E_FORCE_DRILL_ADMIN=1 deno test ...` 可单独验证回退路径，
 * 也用于邮件服务未配置（注册恒 403）的 CI 环境；默认 `false` 时优先 HTTP 注册。
 */
const FORCE_DRILL_ADMIN = Deno.env.get("DRILL_E2E_FORCE_DRILL_ADMIN") === "1";

// ── 每次运行独立的密钥（启动期校验要求 ≥32 字符且非占位值）────────────────────

/** 本运行专用的 JWT 密钥（随机 base64，独立于 TFA 密钥）。 */
const JWT_SECRET_VALUE = randomSecret();
/** 本运行专用的 TFA 加密密钥（必须独立于 JWT_SECRET）。 */
const TFA_ENCRYPTION_KEY_VALUE = randomSecret();

// ── 类型 ────────────────────────────────────────────────────────────────────

/** 演练单步结论（与 verify.ts 的 VerifyStep 同形）。 */
type StepStatus = "passed" | "failed" | "warning" | "skipped";

interface VerifyStep {
  step: string;
  status: StepStatus;
  detail: string;
}

/** 演练汇总（与 verify.ts 的 VerifyResult 同形）。 */
interface VerifyResult {
  passed: boolean;
  steps: VerifyStep[];
  firstFailure: string | null;
}

/** 演练真实发出的一个 HTTP 请求（子进程记录型 fetch 回传）。 */
interface RecordedRequest {
  method: string;
  url: string;
  status: number;
}

/** 一次演练子进程的产出。 */
interface DrillRun {
  result: VerifyResult;
  requests: RecordedRequest[];
}

/** 演练账号。 */
interface DrillAccount {
  username: string;
  password: string;
}

/** 子进程执行结果。 */
interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 已启动的 core 句柄。 */
interface CoreProcess {
  baseUrl: string;
  /** core 是否已退出（退出码；仍在运行返回 null）。 */
  exitCode(): number | null;
  /** 日志尾部（失败时贴出来）。 */
  tail(lines: number): string;
  /** 停止进程并等待管道收尾（幂等）。 */
  stop(): Promise<void>;
}

/** 步骤状态白名单（用于把 unknown 校验成 StepStatus）。 */
const STEP_STATUSES: readonly string[] = [
  "passed",
  "failed",
  "warning",
  "skipped",
];

// ── 小工具（保持零外部依赖：本文件不 import 任何包）──────────────────────────

/** 睡眠。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 随机十六进制串（用于库名/用户名后缀）。 */
function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * 生成随机强密钥（base64，48 字符）。
 *
 * 刻意校验一次占位值黑名单（core 启动会硬拒绝占位密钥），虽然随机串撞上的
 * 概率可以忽略，但失败一次就要重跑整条 E2E，不值得赌。
 */
function randomSecret(): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const bytes = new Uint8Array(36);
    crypto.getRandomValues(bytes);
    const value = btoa(String.fromCharCode(...bytes));
    if (!/change|example|placeholder|random-string|^test$/i.test(value)) {
      return value;
    }
  }
  throw new Error("连续生成到占位风格的密钥，随机源异常");
}

/** 把任意值收窄成“记录对象”。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 截断长文本（错误信息里贴日志用）。 */
function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max
    ? trimmed
    : `…（前 ${max} 字符）\n${trimmed.slice(0, max)}`;
}

/** 断言（零依赖）。 */
function ensure(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** 从 PG 管理连接串派生指定库的连接串。 */
function databaseUrl(dbName: string): string {
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** 选一个当前空闲的本地端口（core 的 `PORT`）。 */
function pickFreePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/** 读取整个可读流为文本。 */
async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const merged = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

/** 执行子进程（stdin 可选；`env` 在父进程环境之上追加/覆盖）。 */
async function runCommand(
  bin: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
  } = {},
): Promise<CommandResult> {
  const child = new Deno.Command(bin, {
    args,
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  if (options.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.stdin));
    await writer.close();
  }

  const [status, stdout, stderr] = await Promise.all([
    child.status,
    readStream(child.stdout),
    readStream(child.stderr),
  ]);
  return { code: status.code, stdout, stderr };
}

/** 执行子进程；命令不存在/无法启动时返回 null（用于前置探测）。 */
async function tryRunCommand(
  bin: string,
  args: string[],
): Promise<CommandResult | null> {
  try {
    return await runCommand(bin, args);
  } catch {
    return null;
  }
}

// ── 隔离数据库（经 docker exec 里的 psql，本机没有宿主 psql）──────────────────

/** 在管理库里执行一段 SQL（`-c` 直接传，不经 shell，避免引号问题）。 */
async function psqlAdmin(sql: string): Promise<string> {
  const result = await runCommand("docker", [
    "exec",
    "-i",
    PG_CONTAINER,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-X",
    "-q",
    "-A",
    "-t",
    "-U",
    PG_USER,
    "-d",
    PG_ADMIN_DATABASE,
    "-c",
    sql,
  ]);
  ensure(
    result.code === 0,
    `psql 执行失败（退出码 ${result.code}）：${truncate(result.stderr, 800)}`,
  );
  return result.stdout;
}

/** 在隔离库里执行一段 SQL。 */
async function psqlDatabase(dbName: string, sql: string): Promise<string> {
  const result = await runCommand("docker", [
    "exec",
    "-i",
    PG_CONTAINER,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-X",
    "-q",
    "-A",
    "-t",
    "-U",
    PG_USER,
    "-d",
    dbName,
    "-c",
    sql,
  ]);
  ensure(
    result.code === 0,
    `psql（${dbName}）执行失败（退出码 ${result.code}）：${
      truncate(result.stderr, 800)
    }`,
  );
  return result.stdout;
}

/** 创建隔离库。 */
async function createDatabase(dbName: string): Promise<void> {
  // 库名由本文件生成（前缀 + 十六进制后缀），无需转义；仍加引号以防误用。
  await psqlAdmin(`CREATE DATABASE "${dbName}"`);
}

/** 强制删除隔离库（core 已停，WITH (FORCE) 兜底清理残留连接）。 */
async function dropDatabase(dbName: string): Promise<void> {
  try {
    await psqlAdmin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    console.log(`[cleanup] 已删除隔离数据库 ${dbName}`);
  } catch (error) {
    // 清理失败不能掩盖主断言结果，但要明确告知（否则下次跑会看到残留库）。
    console.warn(
      `[cleanup] 删除隔离数据库 ${dbName} 失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * 用生产演练同款 SQL 写入 `drill_admin`。
 *
 * 逐字对应 `noj-cli/src/prod/drill/drill.ts` 的 `seedDrillAdmin()`：
 * - id 固定 `drill-admin-user`，重复写入 `ON CONFLICT DO NOTHING` 幂等；
 * - **不显式写 `email_verified`**：新 schema 默认 true（迁移 0064），显式写死反而
 *   无法验收历史快照；
 * - 授权事实只有 `users.role`：角色/权限关联表已随本次重构删除（迁移 0133），
 *   因此必须与 `drill.ts` 的 `seedDrillAdmin()` 一样直接写用户行。
 */
async function seedDrillAdmin(dbName: string): Promise<void> {
  const stamp = "2026-01-01T00:00:00.000Z";
  const sql = [
    "INSERT INTO users (id, username, email, password_hash, created_at, updated_at)",
    `VALUES ('drill-admin-user', '${DRILL_ADMIN_USER}', 'drill-admin@${DRILL_ADMIN_EMAIL_DOMAIN}',`,
    `        '${DRILL_BCRYPT_HASH}', '${stamp}', '${stamp}')`,
    "ON CONFLICT (id) DO NOTHING;",
    "UPDATE users SET role = 'admin' WHERE id = 'drill-admin-user';",
  ].join("\n");
  await psqlDatabase(dbName, sql);
}

// ── core 子进程 ─────────────────────────────────────────────────────────────

/** 构造 core 启动环境（对齐 `noj-core/.env.example` 与 e2e compose）。 */
function coreEnvironment(
  dbName: string,
  port: number,
  storageDir: string,
): Record<string, string> {
  return {
    // 致命启动项：JWT / TFA 独立随机密钥；schema 兼容检查依赖真实迁移。
    DATABASE_URL: databaseUrl(dbName),
    REDIS_URL,
    JWT_SECRET: JWT_SECRET_VALUE,
    TFA_ENCRYPTION_KEY: TFA_ENCRYPTION_KEY_VALUE,
    PORT: String(port),
    // 非生产环境：生产配置护栏不启用；健康端点返回依赖明细（便于失败归因）。
    NOJ_ENV: "test",
    // 本地对象存储落到临时目录，避免污染 noj-core/data/storage。
    STORAGE_PROVIDER: "local",
    SUPPORT_PACKAGE_DIR: storageDir,
    // 演练只用三四个请求，关掉限流避免 IP 维度噪声。
    RATE_LIMIT_ENABLED: "false",
    LOG_LEVEL: "info",
    LOG_FORMAT: "pretty",
    NO_COLOR: "1",
    DENO_NO_UPDATE_CHECK: "1",
  };
}

/** 启动 `deno run -A src/main.ts` 并持续收集日志尾部。 */
function startCore(
  dbName: string,
  port: number,
  storageDir: string,
): CoreProcess {
  const child = new Deno.Command("deno", {
    args: ["run", "-A", "src/main.ts"],
    cwd: CORE_DIR,
    env: coreEnvironment(dbName, port, storageDir),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const lines: string[] = [];
  let exited: number | null = null;
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        for (
          const line of decoder.decode(chunk, { stream: true }).split("\n")
        ) {
          if (line.trim() === "") continue;
          lines.push(line);
          // 只留尾部：E2E 期间的 core 日志可能刷得很快。
          if (lines.length > 400) lines.splice(0, lines.length - 400);
        }
      }
    } catch {
      // 进程被停止时管道会中断，这里不代表启动失败。
    }
  };
  const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);
  void child.status.then((status) => {
    exited = status.code;
  }).catch(() => {
    exited = -1;
  });

  let stopped = false;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    exitCode: () => exited,
    tail: (count: number) => lines.slice(-count).join("\n"),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      // 先 SIGTERM 走 core 的优雅关闭（排空 HTTP → 停任务 → 关 Redis/PG）。
      try {
        child.kill("SIGTERM");
      } catch {
        // 已经退出：无需再发信号。
      }
      const clean = await Promise.race([
        child.status.then(() => true).catch(() => true),
        sleep(CORE_STOP_TIMEOUT_MS).then(() => false),
      ]);
      if (!clean) {
        try {
          child.kill("SIGKILL");
        } catch {
          // 竞争状态下进程可能刚好退出。
        }
        await child.status.catch(() => undefined);
      }
      await pumps;
    },
  };
}

/** 轮询 `/health/ready` 直到 core 就绪（依赖探针全 up 才是 200）。 */
async function waitForCoreReady(core: CoreProcess): Promise<void> {
  const deadline = Date.now() + CORE_READY_TIMEOUT_MS;
  let last = "尚未收到响应";
  let attempt = 0;
  while (Date.now() < deadline) {
    const code = core.exitCode();
    ensure(
      code === null,
      `core 进程提前退出（退出码 ${code}）\n--- core 日志尾部 ---\n${
        core.tail(40)
      }`,
    );
    attempt++;
    try {
      const response = await fetch(`${core.baseUrl}/health/ready`, {
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      const payload: unknown = await response.json().catch(() => null);
      const status = isRecord(payload) && typeof payload.status === "string"
        ? payload.status
        : "unknown";
      if (response.ok && status === "ready") return;
      last = `HTTP ${response.status}（status=${status}）`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt % 20 === 0) console.log(`[setup] 等待 core 就绪… ${last}`);
    await sleep(500);
  }
  throw new Error(
    `core 在 ${CORE_READY_TIMEOUT_MS / 1000}s 内未就绪（最后状态：${last}）\n` +
      `--- core 日志尾部 ---\n${core.tail(40)}`,
  );
}

// ── 演练子进程（deno eval，按 CLI 自己的 import map 解析）────────────────────

/**
 * 生成演练脚本。
 *
 * 关键点：注入的是**记录型 fetch**——它调用真实 `fetch` 并把每个请求的
 * 方法/URL/状态码收集起来随结果一起回传。断言“演练真的走域入口”因此建立在
 * **实际流量**上，而不是步骤文案自述。
 */
function buildDrillScript(options: {
  baseUrl: string;
  account: DrillAccount;
}): string {
  return `
const { runBusinessVerification } = await import(${
    JSON.stringify(VERIFY_MODULE_URL)
  });
const requests = [];
const recordingFetch = async (input, init) => {
  const response = await fetch(input, init);
  const url = typeof input === "string" ? input : input.url;
  const method = (init && init.method) ||
    (typeof input === "string" ? "GET" : input.method);
  requests.push({
    method: String(method).toUpperCase(),
    url,
    status: response.status,
  });
  return response;
};
const result = await runBusinessVerification({
  baseUrl: ${JSON.stringify(options.baseUrl)},
  fetch: recordingFetch,
  adminUser: ${JSON.stringify(options.account.username)},
  adminPassword: ${JSON.stringify(options.account.password)},
  // 只做 login + problem_read + register_probe：评测需要 judge 沙箱镜像，
  // 与本条验收（域入口契约）无关。
  skipEvaluation: true,
  domain: ${JSON.stringify(DOMAIN)},
  log: (line) => console.error(line),
});
console.log(JSON.stringify({ result, requests }));
`;
}

/** 校验子进程回传的演练结果形状（不给任何隐式 any 留口子）。 */
function isVerifyResult(value: unknown): value is VerifyResult {
  if (!isRecord(value)) return false;
  if (typeof value.passed !== "boolean") return false;
  if (value.firstFailure !== null && typeof value.firstFailure !== "string") {
    return false;
  }
  if (!Array.isArray(value.steps)) return false;
  return value.steps.every((step) =>
    isRecord(step) &&
    typeof step.step === "string" &&
    typeof step.status === "string" &&
    STEP_STATUSES.includes(step.status) &&
    typeof step.detail === "string"
  );
}

/** 校验子进程回传的请求记录形状。 */
function isRecordedRequest(value: unknown): value is RecordedRequest {
  return isRecord(value) &&
    typeof value.method === "string" &&
    typeof value.url === "string" &&
    typeof value.status === "number";
}

/** 校验请求记录列表形状。 */
function isRecordedRequestList(
  value: unknown,
): value is RecordedRequest[] {
  return Array.isArray(value) && value.every(isRecordedRequest);
}

/** 在子进程输出里找最后一个可解析的演练结果行。 */
function parseDrillPayload(stdout: string): DrillRun | null {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (!isVerifyResult(parsed.result)) continue;
    if (!isRecordedRequestList(parsed.requests)) continue;
    return { result: parsed.result, requests: parsed.requests };
  }
  return null;
}

/**
 * 在 noj-cli 目录里跑一次真实 HTTP 演练。
 *
 * 用「临时文件 + `deno run -A --config <cli>/deno.json`」而不是 `deno eval -A`：
 * `eval` 的权限旗标随 Deno 版本变化（CI 的 2.9.5 上 `deno eval -A` 直接
 * `unexpected argument '-A' found`），`run -A` 才是跨版本稳定的入口。
 * 脚本放在系统临时目录、通过 `--config` 注入 CLI 的 import map，因此既能解析
 * `fflate` 等裸标识符，也不在仓库里落文件。
 */
async function runDrill(
  baseUrl: string,
  account: DrillAccount,
): Promise<DrillRun> {
  const script = buildDrillScript({
    baseUrl: `${baseUrl}/api/v1`,
    account,
  });
  const probeDir = await Deno.makeTempDir({ prefix: "noj-drill-probe-" });
  const probePath = `${probeDir}/run-drill.ts`;
  await Deno.writeTextFile(probePath, script);
  let result: CommandResult;
  try {
    result = await runCommand(
      "deno",
      ["run", "-A", "--config", CLI_CONFIG_PATH, probePath],
      { cwd: CLI_DIR, env: { NO_COLOR: "1", DENO_NO_UPDATE_CHECK: "1" } },
    );
  } finally {
    await Deno.remove(probeDir, { recursive: true }).catch(() => {});
  }
  ensure(
    result.code === 0,
    `演练子进程退出码 ${result.code}\n--- 演练日志（stderr）---\n${
      truncate(result.stderr, 4000)
    }\n--- stdout ---\n${truncate(result.stdout, 2000)}`,
  );
  const payload = parseDrillPayload(result.stdout);
  if (payload === null) {
    throw new Error(
      "未在演练子进程 stdout 里找到可解析的结果 JSON\n" +
        `--- stdout ---\n${truncate(result.stdout, 4000)}\n` +
        `--- 演练日志（stderr）---\n${truncate(result.stderr, 2000)}`,
    );
  }
  return payload;
}

// ── 账号准备 ────────────────────────────────────────────────────────────────

/** 用登录端点换 token（仅用于「注册账号能不能读域列表」的前置判断）。 */
async function loginForToken(
  baseUrl: string,
  account: DrillAccount,
): Promise<string | null> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      login: account.username,
      password: account.password,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (response.status !== 200 || !isRecord(payload)) return null;
  const data = payload.data;
  return isRecord(data) && typeof data.token === "string" ? data.token : null;
}

/**
 * 优先走真实 HTTP 注册一个随机账号（不写库）。
 *
 * 注册成功后再确认两件事，否则回退 SQL 管理员：
 * 1. 该账号能登录；
 * 2. 该账号能 200 读到 `main` 域题目列表（演练 `problem_read` 的实际依赖）。
 *
 * 注：`skipEvaluation` 的三步不需要 admin 权限（域列表是 `optionalAuthMiddleware`
 * + 公共域），因此普通账号即可覆盖本条验收；一旦将来改成非 skip 模式（导入/发布/
 * 评测），必须用 `drill_admin`。
 */
async function tryRegisterAccount(
  baseUrl: string,
): Promise<DrillAccount | null> {
  if (FORCE_DRILL_ADMIN) {
    console.log(
      "[setup] DRILL_E2E_FORCE_DRILL_ADMIN=1：跳过 HTTP 注册，直接使用演练 SQL 管理员",
    );
    return null;
  }
  const username = `drill_e2e_${randomHex(4)}`;
  const account: DrillAccount = {
    username,
    password: DRILL_ADMIN_PASSWORD,
  };
  const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      email: `${username}@${DRILL_ADMIN_EMAIL_DOMAIN}`,
      password: account.password,
      // PIPL 硬门槛：不带 accepted_legal 注册恒 400。
      accepted_legal: true,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text().catch(() => "");
  if (response.status !== 201) {
    console.log(
      `[setup] HTTP 注册不可用（HTTP ${response.status}：${
        truncate(text, 160)
      }），改用 SQL 写入的演练管理员`,
    );
    return null;
  }

  const token = await loginForToken(baseUrl, account);
  if (!token) {
    console.log("[setup] 注册账号登录失败，改用 SQL 写入的演练管理员");
    return null;
  }
  const list = await fetch(
    `${baseUrl}/api/v1/domains/${DOMAIN}/problems?page=1&limit=20`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  await list.body?.cancel();
  if (list.status !== 200) {
    console.log(
      `[setup] 注册账号读取域题目列表返回 HTTP ${list.status}，改用 SQL 写入的演练管理员`,
    );
    return null;
  }
  console.log(
    `[setup] 已通过 HTTP 注册演练账号 ${username}（登录 + 域列表均 200）`,
  );
  return account;
}

// ── 契约面探针（与演练解耦的独立证据）────────────────────────────────────────

/** 断言旧接口已删除、域入口存在、域列表可用。 */
async function assertContractSurface(baseUrl: string): Promise<void> {
  // F3 的原始 bug 面：无域 import-bundle 在 0.11 已删除，真实 core 必须 404。
  const legacy = await fetch(`${baseUrl}/api/v1/problems/import-bundle`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  await legacy.body?.cancel();
  ensure(
    legacy.status === 404,
    `旧接口 POST /api/v1/problems/import-bundle 期望 404，实际 ${legacy.status}`,
  );
  console.log(
    "[contract] 旧接口 POST /api/v1/problems/import-bundle → 404（已删除）",
  );

  // 域入口必须存在：未认证时应是 401/403（不是 404）。
  const domainEntry = await fetch(
    `${baseUrl}/api/v1/domains/${DOMAIN}/problems/import-bundle`,
    { method: "POST", signal: AbortSignal.timeout(10_000) },
  );
  await domainEntry.body?.cancel();
  ensure(
    domainEntry.status === 401 || domainEntry.status === 403,
    `域入口 POST /api/v1/domains/${DOMAIN}/problems/import-bundle 期望 401/403（路由存在、仅缺认证），实际 ${domainEntry.status}`,
  );
  console.log(
    `[contract] 域入口 POST /api/v1/domains/${DOMAIN}/problems/import-bundle → ${domainEntry.status}（路由存在）`,
  );

  // 演练 problem_read 消费的响应形状：page/limit/total/items。
  const list = await fetch(
    `${baseUrl}/api/v1/domains/${DOMAIN}/problems?page=1&limit=20`,
    { signal: AbortSignal.timeout(10_000) },
  );
  const payload: unknown = await list.json().catch(() => null);
  ensure(
    list.status === 200,
    `GET /api/v1/domains/${DOMAIN}/problems 期望 200，实际 ${list.status}`,
  );
  if (
    !isRecord(payload) || !Array.isArray(payload.items) ||
    typeof payload.total !== "number"
  ) {
    throw new Error(
      `域题目列表响应形状不符（应含 items 数组与数字 total）：${
        truncate(JSON.stringify(payload), 300)
      }`,
    );
  }
  console.log(
    `[contract] GET /api/v1/domains/${DOMAIN}/problems → 200（items=${payload.items.length}，total=${payload.total}）`,
  );
}

// ── 断言 ────────────────────────────────────────────────────────────────────

/**
 * 扫描文本里是否出现**无域前缀**的旧接口片段。
 *
 * 合法形态只有 `/domains/<domain>/problems...` 与 `/domains/<domain>/self-tests...`；
 * 其余出现位置（如 `/problems/import-bundle`、`/self-tests/<id>`）都是 0.10 时代的
 * 契约残留，正是 F3 里让 825 个 mock 单测全绿的那个盲区。
 */
function assertNoLegacyFragment(
  where: string,
  text: string,
  domain: string,
): void {
  const scopedPrefix = `/domains/${domain}/`;
  for (const fragment of ["/problems", "/self-tests"]) {
    let index = text.indexOf(fragment);
    while (index >= 0) {
      const head = text.slice(0, index + fragment.length);
      // 片段以 "/" 开头，域前缀的结尾也是 "/"：拼起来正好是域内合法路径。
      const scoped = `${scopedPrefix}${fragment.slice(1)}`;
      if (!head.endsWith(scoped)) {
        const excerpt = text.slice(
          Math.max(0, index - 30),
          index + fragment.length + 30,
        );
        throw new Error(
          `${where} 出现无域前缀的旧接口片段「${fragment}」：…${excerpt}…`,
        );
      }
      index = text.indexOf(fragment, index + fragment.length);
    }
  }
}

/** 找到某个步骤（不存在即失败）。 */
function requireStep(result: VerifyResult, name: string): VerifyStep {
  const step = result.steps.find((item) => item.step === name);
  if (step === undefined) {
    throw new Error(
      `演练结果缺少步骤 ${name}；实际步骤：${
        result.steps.map((item) => item.step).join("、")
      }`,
    );
  }
  return step;
}

/** 该步骤是否“不算失败”（存在且 status !== failed）。 */
function stepNotFailed(result: VerifyResult, name: string): boolean {
  const step = result.steps.find((item) => item.step === name);
  return step !== undefined && step.status !== "failed";
}

/** §验收断言：演练结果 + 真实请求的契约面。 */
function assertAcceptance(run: DrillRun, domain: string): void {
  const { result, requests } = run;

  ensure(
    result.passed === true,
    `演练未通过：firstFailure=${result.firstFailure ?? "null"}；steps=${
      JSON.stringify(result.steps)
    }`,
  );
  ensure(
    result.firstFailure === null,
    `演练 passed=true 但 firstFailure 非空：${result.firstFailure}`,
  );

  // 三个必需/观察步骤必须出现且不得 failed（register_probe 允许 warning）。
  for (const name of ["login", "problem_read", "register_probe"]) {
    const step = requireStep(result, name);
    ensure(
      step.status !== "failed",
      `步骤 ${name} 失败：${step.detail}`,
    );
    ensure(
      step.status !== "skipped",
      `步骤 ${name} 被跳过：${step.detail}`,
    );
  }
  ensure(
    requireStep(result, "login").status === "passed",
    `login 未 passed：${requireStep(result, "login").detail}`,
  );
  ensure(
    requireStep(result, "problem_read").status === "passed",
    `problem_read 未 passed：${requireStep(result, "problem_read").detail}`,
  );

  // 契约面（0）：步骤结论必须与真实 HTTP 状态码自洽——这正是 F3 里 mock 与
  // 真实契约脱节的症结，单看 status 字段不够，要拿真实请求对账。
  const registerRequest = requests.find((request) =>
    new URL(request.url).pathname === "/api/v1/auth/register"
  );
  if (registerRequest === undefined) {
    throw new Error(
      "演练没有发出真实 POST /api/v1/auth/register（register_probe 证据缺失）",
    );
  }
  const registerStep = requireStep(result, "register_probe");
  ensure(
    (registerRequest.status === 201) === (registerStep.status === "passed"),
    `register_probe 结论与真实 HTTP 状态不一致：步骤 ${registerStep.status}，` +
      `真实状态 ${registerRequest.status}`,
  );

  // 契约面（1）：步骤文案里不得出现无域前缀的旧接口。
  assertNoLegacyFragment("演练结果", JSON.stringify(result), domain);

  // 契约面（2）：真实请求只能落在认证端点或域题目入口。
  const authPaths = new Set(["/api/v1/auth/login", "/api/v1/auth/register"]);
  const domainProblemsPrefix = `/api/v1/domains/${domain}/problems`;
  let domainListCalls = 0;
  for (const request of requests) {
    const { pathname } = new URL(request.url);
    assertNoLegacyFragment(`${request.method} ${pathname}`, pathname, domain);
    if (authPaths.has(pathname)) continue;
    ensure(
      pathname.startsWith(domainProblemsPrefix),
      `演练发出了域题目入口之外的请求：${request.method} ${pathname}`,
    );
    if (request.method === "GET" && pathname === domainProblemsPrefix) {
      ensure(
        request.status === 200,
        `域题目列表请求返回 ${request.status}：${request.url}`,
      );
      domainListCalls++;
    }
  }
  ensure(
    domainListCalls > 0,
    `演练没有真实请求 GET ${domainProblemsPrefix}（problem_read 证据缺失）`,
  );

  // 契约面（3）：login 的真实 HTTP 状态必须是 200。
  ensure(
    requests.some((request) =>
      request.method === "POST" &&
      new URL(request.url).pathname === "/api/v1/auth/login" &&
      request.status === 200
    ),
    "演练没有成功的真实 POST /api/v1/auth/login（200）",
  );
}

/** 打印证据（steps + 真实请求），便于在 CI 日志里直接看到契约面。 */
function printEvidence(run: DrillRun): void {
  for (const step of run.result.steps) {
    console.log(`[drill] ${step.step} → ${step.status} :: ${step.detail}`);
  }
  for (const request of run.requests) {
    const url = new URL(request.url);
    console.log(
      `[drill] HTTP ${request.method} ${url.pathname}${url.search} → ${request.status}`,
    );
  }
  console.log(`[drill] steps JSON: ${JSON.stringify(run.result.steps)}`);
}

// ── 前置探测（缺依赖 → 跳过，不失败）────────────────────────────────────────

/** 返回跳过原因；全部就绪返回 null。 */
async function detectSkipReason(): Promise<string | null> {
  const docker = await tryRunCommand("docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  if (!docker || docker.code !== 0) {
    return "未找到可用的 docker CLI/daemon（建库/删库需 docker exec psql）";
  }

  const pg = await tryRunCommand("docker", [
    "exec",
    PG_CONTAINER,
    "psql",
    "-X",
    "-q",
    "-c",
    "select 1",
    "-U",
    PG_USER,
    "-d",
    PG_ADMIN_DATABASE,
  ]);
  if (!pg || pg.code !== 0) {
    return `PostgreSQL 容器 ${PG_CONTAINER} 不可用（${
      truncate(pg?.stderr ?? "命令无法执行", 200)
    }）`;
  }

  const redis = await tryRunCommand("docker", [
    "exec",
    REDIS_CONTAINER,
    "redis-cli",
    "ping",
  ]);
  if (!redis || redis.code !== 0 || !redis.stdout.includes("PONG")) {
    return `Redis 容器 ${REDIS_CONTAINER} 不可用（${
      truncate(redis?.stderr ?? "命令无法执行", 200)
    }）`;
  }

  return null;
}

/** 用 core 自带脚本跑迁移（HTTP 启动只做只读 schema 兼容检查，不建表）。 */
async function migrateDatabase(dbName: string): Promise<void> {
  const result = await runCommand(
    "deno",
    ["run", "-A", "scripts/migrate.ts"],
    {
      cwd: CORE_DIR,
      env: {
        DATABASE_URL: databaseUrl(dbName),
        REDIS_URL,
        JWT_SECRET: JWT_SECRET_VALUE,
        TFA_ENCRYPTION_KEY: TFA_ENCRYPTION_KEY_VALUE,
        NOJ_ENV: "test",
        NO_COLOR: "1",
      },
    },
  );
  ensure(
    result.code === 0,
    `数据库迁移失败（退出码 ${result.code}）\n--- stdout ---\n${
      truncate(result.stdout, 2000)
    }\n--- stderr ---\n${truncate(result.stderr, 4000)}`,
  );
}

/**
 * 系统基础数据初始化（root 用户 + RBAC 种子 + 默认 `main` 工作空间）。
 *
 * 空库的迁移**不会**创建 `main` 域：0116 的回填依赖已存在的 root 用户
 * （`WHERE u.id = '0'`），所以必须先跑 `noj init system`。
 */
async function initSystem(dbName: string): Promise<void> {
  const result = await runCommand(
    "deno",
    ["run", "-A", "scripts/noj.ts", "init", "system"],
    {
      cwd: CORE_DIR,
      env: {
        DATABASE_URL: databaseUrl(dbName),
        REDIS_URL,
        JWT_SECRET: JWT_SECRET_VALUE,
        TFA_ENCRYPTION_KEY: TFA_ENCRYPTION_KEY_VALUE,
        NOJ_ENV: "test",
        NO_COLOR: "1",
      },
    },
  );
  ensure(
    result.code === 0,
    `系统初始化失败（退出码 ${result.code}）\n--- stdout ---\n${
      truncate(result.stdout, 2000)
    }\n--- stderr ---\n${truncate(result.stderr, 4000)}`,
  );
}

// ── 测试主体 ────────────────────────────────────────────────────────────────

Deno.test({
  name: "[e2e/cross-domain] 恢复演练业务验收走域入口（真实 core HTTP 契约）",
  ignore: !isE2E,
  // 子进程编排会长期持有管道与子进程句柄，资源/操作 sanitizer 不适用于本用例。
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const startedAt = Date.now();

    const skipReason = await detectSkipReason();
    if (skipReason !== null) {
      console.log(`[skip] ${skipReason}；跳过真实 HTTP 契约演练`);
      return;
    }

    const suffix = randomHex(4);
    const dbName = `noj_drill_e2e_${suffix}`;
    const storageDir = await Deno.makeTempDir({
      prefix: "noj-drill-e2e-storage-",
    });
    let core: CoreProcess | null = null;
    let dbCreated = false;
    try {
      await createDatabase(dbName);
      dbCreated = true;
      console.log(`[setup] 已创建隔离数据库 ${dbName}`);

      await migrateDatabase(dbName);
      console.log("[setup] 迁移完成（真实 drizzle 迁移集）");

      await initSystem(dbName);
      console.log("[setup] 系统初始化完成（root + RBAC + main 域）");

      const port = pickFreePort();
      core = startCore(dbName, port, storageDir);
      await waitForCoreReady(core);
      console.log(`[setup] core 就绪：${core.baseUrl}/health/ready`);

      // 与演练解耦的契约探针：先证明“旧接口确实不存在、域入口确实存在”。
      await assertContractSurface(core.baseUrl);

      // 账号：优先 HTTP 注册（不写库），不可用/无权限时回退生产演练 SQL。
      let account = await tryRegisterAccount(core.baseUrl);
      if (account === null) {
        await seedDrillAdmin(dbName);
        account = {
          username: DRILL_ADMIN_USER,
          password: DRILL_ADMIN_PASSWORD,
        };
        console.log(
          "[setup] 已按生产演练 SQL 写入 drill_admin（含 admin 角色）",
        );
      }

      let run = await runDrill(core.baseUrl, account);
      if (
        !stepNotFailed(run.result, "problem_read") &&
        account.username !== DRILL_ADMIN_USER
      ) {
        // 验收要求的安全网：普通账号读不到域题目列表时，改用演练固定管理员重跑一次。
        console.log(
          "[setup] 普通账号 problem_read 失败，回退到 SQL 演练管理员重跑演练",
        );
        await seedDrillAdmin(dbName);
        account = {
          username: DRILL_ADMIN_USER,
          password: DRILL_ADMIN_PASSWORD,
        };
        run = await runDrill(core.baseUrl, account);
      }

      printEvidence(run);
      assertAcceptance(run, DOMAIN);
      console.log(
        `[done] 真实 HTTP 契约演练通过（用时 ${
          ((Date.now() - startedAt) / 1000).toFixed(1)
        }s，账号 ${account.username}）`,
      );
    } catch (error) {
      if (core !== null) {
        console.error(`[core] 日志尾部：\n${core.tail(40)}`);
      }
      throw error;
    } finally {
      // 顺序固定：先停 core（释放 PG/Redis 连接），再删库，最后删存储目录。
      await core?.stop();
      if (dbCreated) await dropDatabase(dbName);
      try {
        await Deno.remove(storageDir, { recursive: true });
      } catch {
        // 临时目录可能已被清理，忽略。
      }
    }
  },
});
