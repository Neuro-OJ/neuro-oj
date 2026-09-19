/**
 * install（T12）测试：注入 runner / fetcher / IO，**不触网、不起容器**。
 *
 * 覆盖 brief 的 7 条验收：
 * 1. 空目录安装的顺序与副作用；
 * 2. 幂等/已安装走升级路径（overwrite:true）且保留既有 .env.prod；
 * 3. 非交互缺配置 → 明确报错、零写入；
 * 4. PATH 注册三态（全局 / 用户回退 / 拒绝覆盖）；
 * 5. 失败原子性（校验失败不写 .env.prod、不起 compose）；
 * 6. .env.prod 权限非 600/400 → 安装前拒绝；
 * 7. cosign 不可用 → 可见警告（不静默跳过）。
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import type {
  CmdResult,
  CommandRunner,
  SpawnHandle,
} from "../runtime/command.ts";
import type { PromptIO } from "../tui/io.ts";
import { sha256Hex } from "../util/hash.ts";
import type { Fetcher } from "./bootstrap.ts";
import {
  install,
  type InstallResult,
  missingConfigError,
  PATH_LINE,
} from "./lifecycle.ts";
import { PRODUCTION_MARKERS } from "../profile.ts";

const REPO = "https://github.com/Neuro-OJ/neuro-oj";
const REF = "v0.9.5";
const COMPOSE = "docker-compose.prod.yml";
const ENV_EXAMPLE = ".env.prod.example";
const ENV_FILE = ".env.prod";

const encoder = new TextEncoder();

const COMPOSE_BODY = "services:\n  core:\n    image: noj\n";
const EXAMPLE_BODY = [
  "NOJ_VERSION=change-me-release-tag",
  "NOJ_ENFORCE_IMAGE_SIGNATURES=false",
  "DOMAIN=change-me.example.com",
  "APP_URL=https://change-me.example.com",
  "CORS_ALLOWED_ORIGINS=https://change-me.example.com",
  "TRUSTED_PROXIES=172.28.0.0/16",
  "POSTGRES_PASSWORD=change-me-strong-postgres-password",
  "REDIS_PASSWORD=change-me-strong-redis-password",
  "MINIO_ROOT_USER=change-me-minio-user",
  "MINIO_ROOT_PASSWORD=change-me-strong-minio-password",
  "S3_ACCESS_KEY=change-me-noj-storage-user",
  "S3_SECRET_KEY=change-me-strong-noj-storage-password",
  "S3_BUCKET=noj-support-packages",
  "S3_ENDPOINT=http://minio:9000",
  "STORAGE_PROVIDER=s3",
  "JWT_SECRET=",
  "TFA_ENCRYPTION_KEY=",
  "NOJ_LLM_SERVICE_TOKEN=",
  "NOJ_LLM_STORE_KEY=",
  "EMAIL_PROVIDER=disabled",
  "JUDGE_ENABLED=true",
  "",
].join("\n");

const ASSETS: Record<string, Uint8Array<ArrayBuffer>> = {
  [COMPOSE]: encoder.encode(COMPOSE_BODY),
  [ENV_EXAMPLE]: encoder.encode(EXAMPLE_BODY),
};

/** 一次 runner 调用记录。 */
interface RunnerCall {
  cmd: string;
  args: string[];
}

/**
 * 记录 run 调用的 fake runner；overrides 可让某条命令返回非 0。
 *
 * 同时把调用写进 `events`（同一时间轴），这样「compose 在向导之后」才有可能
 * 用**同一个序列**的索引比较——不同数组的索引不可比。
 */
function makeRunner(
  records: RunnerCall[],
  overrides: (cmd: string, args: string[]) => Partial<CmdResult> | undefined =
    () => undefined,
  events: string[] = [],
): CommandRunner {
  return {
    run(cmd, args) {
      records.push({ cmd, args: [...args] });
      events.push("run:" + cmd + " " + args.join(" "));
      return Promise.resolve({
        code: 0,
        stdout: "",
        stderr: "",
        ...(overrides(cmd, args) ?? {}),
      });
    },
    spawn(): SpawnHandle {
      throw new Error("install 测试不 spawn");
    },
  };
}

/** 队列式 fake IO：依次返回 answers，并记录交互事件顺序。 */
function makeIO(answers: string[], events: string[]): PromptIO {
  let i = 0;
  const take = (kind: string, prompt: string): string => {
    events.push(kind + ":" + prompt);
    return answers[i++] ?? "";
  };
  return {
    write(text) {
      events.push("write:" + text.trim());
    },
    readLine(prompt) {
      return Promise.resolve(take("read", prompt));
    },
    readSecret(prompt) {
      return Promise.resolve(take("secret", prompt));
    },
  };
}

/** 确定性 fake fetcher；checksumOverrides 替换某个资产的 .sha256 正文。 */
function makeFetcher(
  calls: string[],
  events: string[],
  checksumOverrides: Record<string, string> = {},
): Fetcher {
  return async (url: string) => {
    calls.push(url);
    events.push("fetch:" + (url.split("/").pop() ?? ""));
    const name = url.split("/").pop() ?? "";
    if (name.endsWith(".sha256")) {
      const base = name.slice(0, -".sha256".length);
      const override = checksumOverrides[base];
      if (override !== undefined) {
        return new Response(override, { status: 200 });
      }
      const body = ASSETS[base];
      if (body === undefined) return new Response("missing", { status: 404 });
      return new Response((await sha256Hex(body)) + "  " + base + "\n", {
        status: 200,
      });
    }
    const body = ASSETS[name];
    return body === undefined
      ? new Response("missing", { status: 404 })
      : new Response(body, { status: 200 });
  };
}

const HEX = "a".repeat(64);

/** 一份通过 checkRequiredValues 的完整 .env.prod 文本。 */
function completeEnv(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    NOJ_VERSION: "v0.9.5",
    DOMAIN: "oj.test-oj.cn",
    APP_URL: "https://oj.test-oj.cn",
    CORS_ALLOWED_ORIGINS: "https://oj.test-oj.cn",
    TRUSTED_PROXIES: "172.28.0.0/16",
    POSTGRES_PASSWORD: HEX,
    REDIS_PASSWORD: HEX,
    MINIO_ROOT_USER: "nojminio123456",
    MINIO_ROOT_PASSWORD: HEX,
    S3_ACCESS_KEY: "nojs3123456",
    S3_SECRET_KEY: HEX,
    S3_BUCKET: "noj-support-packages",
    S3_ENDPOINT: "http://minio:9000",
    STORAGE_PROVIDER: "s3",
    JWT_SECRET: HEX,
    TFA_ENCRYPTION_KEY: "b".repeat(64),
    NOJ_LLM_SERVICE_TOKEN: "c".repeat(64),
    NOJ_LLM_STORE_KEY: "d".repeat(64),
    EMAIL_PROVIDER: "disabled",
    JUDGE_ENABLED: "false",
    NOJ_ENFORCE_IMAGE_SIGNATURES: "false",
  };
  const merged = { ...base, ...overrides };
  return Object.entries(merged).map(([k, v]) => k + "=" + v).join("\n") + "\n";
}

/** 列出目录条目名（排序）。 */
async function dirNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

/** 建一个「已安装」目录：完整 .env.prod + compose 文件。 */
async function makeInstalledDir(
  envOverrides: Record<string, string> = {},
  mode = 0o600,
): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, ENV_FILE), completeEnv(envOverrides));
  await Deno.writeTextFile(join(dir, COMPOSE), COMPOSE_BODY);
  await Deno.chmod(join(dir, ENV_FILE), mode);
  return dir;
}

/** 预置口令文件（600），让 ensureBackupPassphrase 走"复用"分支。 */
async function writePassphraseFile(path: string): Promise<void> {
  await Deno.writeTextFile(path, "e".repeat(64));
  await Deno.chmod(path, 0o600);
}

/** 造出可执行 bin/noj-cli，令 PATH 注册不落进"源码运行模式"分支。 */
async function makeCliBinary(dir: string): Promise<void> {
  await Deno.mkdir(join(dir, "bin"), { recursive: true });
  await Deno.writeTextFile(join(dir, "bin/noj-cli"), "");
  await Deno.chmod(join(dir, "bin/noj-cli"), 0o755);
}

const indexOfEvent = (events: string[], prefix: string): number =>
  events.findIndex((e) => e.startsWith(prefix));

Deno.test("install 空目录：拉取资产 → 校验 → 生成 .env.prod → 启动 compose（顺序断言）", async () => {
  const dir = await Deno.makeTempDir();
  const root = await Deno.makeTempDir();
  try {
    await makeCliBinary(dir);
    const events: string[] = [];
    const calls: string[] = [];
    const records: RunnerCall[] = [];
    const warnings: string[] = [];
    const passphrase = join(root, "backup-passphrase");
    const io = makeIO(
      ["v0.9.5", "oj.test-oj.cn", "y", "", "y", "", "", "y"],
      events,
    );

    const result: InstallResult = await install({
      dir,
      repository: REPO,
      ref: REF,
      io,
      runner: makeRunner(records, () => undefined, events),
      fetcher: makeFetcher(calls, events),
      isTty: true,
      passphraseFile: passphrase,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(true),
      socketExists: () => Promise.resolve(true),
      binDir: join(root, "bin"),
      userHome: join(root, "home"),
      warn: (m) => warnings.push(m),
      now: new Date("2026-09-19T00:00:00Z"),
    });

    // ── 顺序：拉取 → 校验 → 生成 .env.prod → compose ──
    assertEquals(calls.length, 4, "必须下载 2 个资产 + 2 个 .sha256");
    const firstFetch = indexOfEvent(events, "fetch:");
    const firstPrompt = indexOfEvent(events, "read:");
    const firstDocker = indexOfEvent(events, "run:docker");
    assert(firstFetch >= 0, "必须先拉取资产");
    assert(
      firstPrompt > firstFetch,
      "配置向导必须在资产拉取之后（洞 2：install 先自举）",
    );
    assert(firstDocker > firstPrompt, "compose 必须在向导之后");
    // 审计：.env.prod 在向导**期间**落盘（seed 早于向导，向导内提交）。
    assert(
      indexOfEvent(events, "write:配置已写入") > firstPrompt,
      "配置必须由向导提交后才可用",
    );

    // ── 步骤记录（含 T9 carry-forward：首次安装 overwrite:false）──
    assertEquals(result.steps.map((s) => s.name), [
      "bootstrap",
      "seed-env",
      "configure",
      "passphrase",
      "validate",
      "verify-images",
      "compose-pull",
      "compose-up",
      "record-metadata",
      "register",
    ]);
    assertEquals(result.steps[0]?.overwrite, false);
    assertEquals(result.created, true);

    // ── 文件系统效果 ──
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), COMPOSE_BODY);
    assertEquals(await Deno.readTextFile(join(dir, ENV_EXAMPLE)), EXAMPLE_BODY);
    const envText = await Deno.readTextFile(join(dir, ENV_FILE));
    assertStringIncludes(envText, "DOMAIN=oj.test-oj.cn");
    assertStringIncludes(envText, "APP_URL=https://oj.test-oj.cn");
    assertStringIncludes(envText, "JUDGE_DOCKER_SOCKET_GID=10001");
    assertStringIncludes(envText, "POSTGRES_PASSWORD=");
    assert(
      !envText.includes("change-me-strong-postgres-password"),
      "模板占位口令必须被真随机值替换",
    );
    assert(
      !envText.includes("NOJ_VERSION=change-me-release-tag"),
      "版本必须是不可变 Release 标签",
    );
    // carry-forward：口令路径经 targetFile 注入，回填进 .env.prod
    assertStringIncludes(envText, "NOJ_BACKUP_PASSPHRASE_FILE=" + passphrase);
    assertEquals(
      ((await Deno.stat(join(dir, ENV_FILE))).mode ?? 0) & 0o777,
      0o600,
    );
    assertEquals(((await Deno.stat(passphrase)).mode ?? 0) & 0o777, 0o600);

    // ── compose 调用（judge 启用 → 必须带 --profile judge）──
    const composeFile = join(dir, COMPOSE);
    const envFile = join(dir, ENV_FILE);
    const dockerArgs = records.filter((r) => r.cmd === "docker").map(
      (r) => r.args,
    );
    assertEquals(dockerArgs[0], [
      "compose",
      "--env-file",
      envFile,
      "-f",
      composeFile,
      "--profile",
      "judge",
      "config",
    ]);
    assertEquals(dockerArgs[1], [
      "compose",
      "--env-file",
      envFile,
      "-f",
      composeFile,
      "--profile",
      "judge",
      "pull",
    ]);
    assertEquals(dockerArgs[2], [
      "compose",
      "--env-file",
      envFile,
      "-f",
      composeFile,
      "--profile",
      "judge",
      "up",
      "-d",
      "--wait",
    ]);
    assertEquals(result.composeUpCode, 0);
    // 告警必须可见且不静默：新建口令文件 + 模板默认关闭验签各一条。
    assertEquals(warnings, [
      "请将该口令文件安全复制到仓库外的异地位置，否则无法恢复加密快照",
      "NOJ_ENFORCE_IMAGE_SIGNATURES=false，已关闭镜像签名校验",
    ]);
    // 关闭验签时不得调用 cosign / buildx。
    assertEquals(records.some((r) => r.cmd === "cosign"), false);
    assertEquals(result.verified, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("install 已安装目录：升级路径 overwrite:true 且保留既有 .env.prod 内容", async () => {
  const dir = await makeInstalledDir();
  try {
    const original = await Deno.readTextFile(join(dir, ENV_FILE));
    const events: string[] = [];
    const calls: string[] = [];
    const records: RunnerCall[] = [];
    const passphrase = join(dir, "backup-passphrase");
    await writePassphraseFile(passphrase);

    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], events),
      runner: makeRunner(records),
      fetcher: makeFetcher(calls, events),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(true),
      warn: () => {},
    });

    assertEquals(result.created, false);
    assertEquals(result.steps[0]?.name, "bootstrap");
    assertEquals(
      result.steps[0]?.overwrite,
      true,
      "升级路径必须显式 overwrite:true",
    );
    // 既有 .env.prod 逐字节保留（口令文件已存在 → 无回填）
    assertEquals(await Deno.readTextFile(join(dir, ENV_FILE)), original);
    // compose 已按新版本重新下载（overwrite 生效）
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), COMPOSE_BODY);
    assertEquals(calls.length, 4);
    assertEquals(records.some((r) => r.args.includes("up")), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install --non-interactive 缺必需配置：明确报错、不进向导、零写入", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const events: string[] = [];
    const calls: string[] = [];
    const records: RunnerCall[] = [];
    await assertRejects(
      () =>
        install({
          dir,
          repository: REPO,
          ref: REF,
          io: makeIO([], events),
          runner: makeRunner(records),
          fetcher: makeFetcher(calls, events),
          nonInteractive: true,
          processEnv: {},
          warn: () => {},
        }),
      Error,
      "缺少必需配置",
    );
    assertEquals(events, [], "非交互下不得进入向导");
    assertEquals(calls, [], "非交互下不得下载资产");
    assertEquals(records, [], "非交互下不得调用 docker");
    assertEquals(await dirNames(dir), [], "非交互下不得写任何文件");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install --dir /（或空）被拒绝：零副作用", async () => {
  for (const dir of ["/", "", "."]) {
    const events: string[] = [];
    const calls: string[] = [];
    await assertRejects(
      () =>
        install({
          dir,
          repository: REPO,
          ref: REF,
          io: makeIO([], events),
          runner: makeRunner([]),
          fetcher: makeFetcher(calls, events),
          nonInteractive: true,
          processEnv: {},
          warn: () => {},
        }),
      Error,
      "安装目录不安全或为空",
    );
    assertEquals(calls, []);
  }
});

Deno.test("install PATH 注册：优先全局目录并指向 <dir>/bin/noj-cli", async () => {
  const root = await Deno.makeTempDir();
  const dir = await makeInstalledDir();
  try {
    const globalBin = join(root, "usr-local-bin");
    await Deno.mkdir(globalBin, { recursive: true });
    await makeCliBinary(dir);
    const passphrase = join(root, "backup-passphrase");
    await writePassphraseFile(passphrase);

    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], []),
      runner: makeRunner([]),
      fetcher: makeFetcher([], []),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(true),
      binDir: globalBin,
      userHome: join(root, "home"),
      warn: () => {},
    });

    const link = join(globalBin, "noj-cli");
    assertEquals(result.registration.path, link);
    assertEquals(await Deno.readLink(link), join(dir, "bin/noj-cli"));
    assertEquals(result.registration.warnings, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("install PATH 注册：全局目录不可用时回落 ~/.local/bin 并补 PATH", async () => {
  const root = await Deno.makeTempDir();
  const dir = await makeInstalledDir();
  try {
    const blocked = join(root, "blocked-bin");
    await Deno.writeTextFile(blocked, "not a directory\n");
    const home = join(root, "home");
    await Deno.mkdir(home, { recursive: true });
    await makeCliBinary(dir);
    const passphrase = join(root, "backup-passphrase");
    await writePassphraseFile(passphrase);

    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], []),
      runner: makeRunner([]),
      fetcher: makeFetcher([], []),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(true),
      binDir: blocked,
      userHome: home,
      warn: () => {},
    });

    const link = join(home, ".local/bin/noj-cli");
    assertEquals(result.registration.path, link);
    assertEquals(await Deno.readLink(link), join(dir, "bin/noj-cli"));
    const profile = await Deno.readTextFile(join(home, ".profile"));
    assertStringIncludes(profile, PATH_LINE);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("install PATH 注册：同名命令指向他处时拒绝覆盖（零副作用）", async () => {
  const root = await Deno.makeTempDir();
  const dir = await makeInstalledDir();
  try {
    const globalBin = join(root, "usr-local-bin");
    await Deno.mkdir(globalBin, { recursive: true });
    await Deno.writeTextFile(join(globalBin, "noj-cli"), "someone-else\n");
    const home = join(root, "home");
    await Deno.mkdir(join(home, ".local/bin"), { recursive: true });
    await Deno.writeTextFile(
      join(home, ".local/bin/noj-cli"),
      "someone-else\n",
    );
    await makeCliBinary(dir);
    const passphrase = join(root, "backup-passphrase");
    await writePassphraseFile(passphrase);

    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], []),
      runner: makeRunner([]),
      fetcher: makeFetcher([], []),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(true),
      binDir: globalBin,
      userHome: home,
      warn: () => {},
    });

    assertEquals(result.registration.path, null);
    assertEquals(
      await Deno.readTextFile(join(globalBin, "noj-cli")),
      "someone-else\n",
    );
    assertEquals(
      await Deno.readTextFile(join(home, ".local/bin/noj-cli")),
      "someone-else\n",
    );
    assert(
      result.registration.warnings.some((w) => w.includes("未覆盖已有命令")),
      "必须在告警中说明未覆盖",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("install 失败原子性：资产校验失败 → 不写 .env.prod、不调用 docker", async () => {
  const dir = await Deno.makeTempDir();
  const root = await Deno.makeTempDir();
  try {
    const events: string[] = [];
    const calls: string[] = [];
    const records: RunnerCall[] = [];
    await assertRejects(
      () =>
        install({
          dir,
          repository: REPO,
          ref: REF,
          io: makeIO(["v0.9.5", "oj.test-oj.cn"], events),
          runner: makeRunner(records),
          fetcher: makeFetcher(calls, events, {
            [ENV_EXAMPLE]: "0".repeat(64),
          }),
          isTty: true,
          passphraseFile: join(root, "backup-passphrase"),
          processEnv: {},
          warn: () => {},
        }),
      Error,
      "SHA-256 校验失败",
    );
    assertEquals(records, [], "校验失败后不得调用 docker");
    assertEquals(
      await dirNames(dir),
      [],
      "校验失败后目录必须保持为空（原子性）",
    );
    assertEquals(events.some((e) => e.startsWith("read:")), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("install 权限：.env.prod 非 600/400 → 安装前拒绝", async () => {
  for (const mode of [0o644, 0o640, 0o666]) {
    const dir = await makeInstalledDir({}, mode);
    try {
      const calls: string[] = [];
      const records: RunnerCall[] = [];
      await assertRejects(
        () =>
          install({
            dir,
            repository: REPO,
            ref: REF,
            io: makeIO([], []),
            runner: makeRunner(records),
            fetcher: makeFetcher(calls, []),
            nonInteractive: true,
            processEnv: {},
            warn: () => {},
          }),
        Error,
        "生产配置文件权限必须为 600 或 400",
      );
      assertEquals(calls, [], "权限不合格时不得下载资产");
      assertEquals(records, [], "权限不合格时不得调用 docker");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("install 权限：.env.prod 为 400 亦可通过", async () => {
  const dir = await makeInstalledDir({}, 0o400);
  try {
    const passphrase = join(dir, "backup-passphrase");
    await writePassphraseFile(passphrase);
    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], []),
      runner: makeRunner([]),
      fetcher: makeFetcher([], []),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: {},
      warn: () => {},
    });
    assertEquals(result.created, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install cosign 不可用：可见警告且不启动 compose（不静默跳过）", async () => {
  const dir = await makeInstalledDir({ NOJ_ENFORCE_IMAGE_SIGNATURES: "true" });
  try {
    const passphrase = join(dir, "backup-passphrase");
    await writePassphraseFile(passphrase);
    const records: RunnerCall[] = [];
    const warnings: string[] = [];
    await assertRejects(
      () =>
        install({
          dir,
          repository: REPO,
          ref: REF,
          io: makeIO([], []),
          runner: makeRunner(records),
          fetcher: makeFetcher([], []),
          nonInteractive: true,
          passphraseFile: passphrase,
          processEnv: {},
          cosignAvailable: () => Promise.resolve(false),
          warn: (m) => warnings.push(m),
        }),
      Error,
      "找不到 Cosign",
    );
    assert(
      warnings.some((w) => w.includes("找不到 Cosign")),
      "跳过验签必须有可见警告，不得静默",
    );
    assertEquals(
      records.some((r) => r.args.includes("pull")),
      false,
      "验签失败后不得拉取/启动 compose",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install cosign：NOJ_ENFORCE_IMAGE_SIGNATURES=false 时显式告警并继续", async () => {
  const dir = await makeInstalledDir();
  try {
    const passphrase = join(dir, "backup-passphrase");
    await writePassphraseFile(passphrase);
    const records: RunnerCall[] = [];
    const warnings: string[] = [];
    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], []),
      runner: makeRunner(records),
      fetcher: makeFetcher([], []),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(true),
      warn: (m) => warnings.push(m),
    });
    assert(
      warnings.some((w) => w.includes("NOJ_ENFORCE_IMAGE_SIGNATURES=false")),
      "关闭验签必须告警（不静默）",
    );
    assertEquals(result.verified, []);
    assertEquals(records.some((r) => r.args.includes("up")), true);
    assertEquals(records.some((r) => r.cmd === "cosign"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install compose up 非 0：报告失败并透传退出码", async () => {
  const dir = await makeInstalledDir();
  try {
    const passphrase = join(dir, "backup-passphrase");
    await writePassphraseFile(passphrase);
    await assertRejects(
      () =>
        install({
          dir,
          repository: REPO,
          ref: REF,
          io: makeIO([], []),
          runner: makeRunner([], (cmd, args) =>
            cmd === "docker" && args.includes("up")
              ? { code: 17, stdout: "", stderr: "boom" }
              : undefined),
          fetcher: makeFetcher([], []),
          nonInteractive: true,
          passphraseFile: passphrase,
          processEnv: {},
          warn: () => {},
        }),
      Error,
      "服务启动或健康检查失败",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install carry-forward T11：调用顺序 judgeEnabledError → validateEnv（枚举非法优先报错）", async () => {
  // JUDGE_ENABLED=maybe 是枚举外值：judgeEnabledError 必须**先**拒绝，
  // 而不是被 validateEnv 静默当成"启用"后报一堆缺失键。
  const dir = await makeInstalledDir({ JUDGE_ENABLED: "maybe" });
  try {
    const passphrase = join(dir, "backup-passphrase");
    await writePassphraseFile(passphrase);
    const records: RunnerCall[] = [];
    await assertRejects(
      () =>
        install({
          dir,
          repository: REPO,
          ref: REF,
          io: makeIO([], []),
          runner: makeRunner(records),
          fetcher: makeFetcher([], []),
          nonInteractive: true,
          passphraseFile: passphrase,
          processEnv: {},
          warn: () => {},
        }),
      Error,
      "JUDGE_ENABLED 必须是 true 或 false",
    );
    // 校验失败必须早于 compose：不得有任何 docker 调用。
    assertEquals(records, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install carry-forward T11：judge 未设置 = 启用（要求 socket 且带 --profile judge）", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // 去掉 JUDGE_ENABLED 行（=未设置=启用），并按"启用"补上 judge 条件键；
    // 否则缺失的是 JUDGE_* 而非 JUDGE_ENABLED，测不到"未设置=启用"。
    const lines = completeEnv({
      JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock",
      JUDGE_DOCKER_SOCKET_GID: "10001",
    })
      .split("\n")
      .filter((l) => !l.startsWith("JUDGE_ENABLED="));
    await Deno.writeTextFile(join(dir, ENV_FILE), lines.join("\n"));
    await Deno.chmod(join(dir, ENV_FILE), 0o600);
    await Deno.writeTextFile(join(dir, COMPOSE), COMPOSE_BODY);
    const passphrase = join(dir, "backup-passphrase");
    await writePassphraseFile(passphrase);
    const records: RunnerCall[] = [];
    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], []),
      runner: makeRunner(records),
      fetcher: makeFetcher([], []),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: {},
      warn: () => {},
      // 未设置 judge → 要求 socket 存在；给出注入点即视为存在。
      socketExists: () => Promise.resolve(true),
    });
    assertEquals(result.created, false);
    assertEquals(
      records
        .filter((r) => r.cmd === "docker")
        .every((r) => r.args.includes("--profile") && r.args.includes("judge")),
      true,
      "judge 未设置 = 启用 → 所有 compose 调用必须带 --profile judge",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install carry-forward T11：--passphrase-file 不抑制回填，仅进程环境抑制", async () => {
  // 场景 A：仅有 --passphrase-file（进程环境无该变量）→ 必须回填进 .env.prod。
  const a = await makeInstalledDir();
  const rootA = await Deno.makeTempDir();
  try {
    const passphrase = join(rootA, "pp");
    await install({
      dir: a,
      repository: REPO,
      ref: REF,
      io: makeIO([], []),
      runner: makeRunner([]),
      fetcher: makeFetcher([], []),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: {},
      warn: () => {},
    });
    assertStringIncludes(
      await Deno.readTextFile(join(a, ENV_FILE)),
      "NOJ_BACKUP_PASSPHRASE_FILE=" + passphrase,
      "旗标路径必须回填（bash :948 只读进程环境）",
    );
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(rootA, { recursive: true });
  }

  // 场景 B：进程环境给出 NOJ_BACKUP_PASSPHRASE_FILE → 抑制回填。
  const b = await makeInstalledDir();
  const rootB = await Deno.makeTempDir();
  try {
    const flagPath = join(rootB, "flag-pp");
    const envPath = join(rootB, "env-pp");
    await writePassphraseFile(envPath);
    await install({
      dir: b,
      repository: REPO,
      ref: REF,
      io: makeIO([], []),
      runner: makeRunner([]),
      fetcher: makeFetcher([], []),
      nonInteractive: true,
      passphraseFile: flagPath,
      processEnv: { NOJ_BACKUP_PASSPHRASE_FILE: envPath },
      warn: () => {},
    });
    const text = await Deno.readTextFile(join(b, ENV_FILE));
    assertEquals(
      text.includes("NOJ_BACKUP_PASSPHRASE_FILE="),
      false,
      "进程环境已给出该变量 → 不得回填",
    );
  } finally {
    await Deno.remove(b, { recursive: true });
    await Deno.remove(rootB, { recursive: true });
  }
});

Deno.test("install carry-forward T11：cosignAvailable 缺省注入真实探测（runner 执行 cosign version）", async () => {
  const dir = await makeInstalledDir({ NOJ_ENFORCE_IMAGE_SIGNATURES: "true" });
  try {
    const passphrase = join(dir, "backup-passphrase");
    await writePassphraseFile(passphrase);
    const records: RunnerCall[] = [];
    const warnings: string[] = [];
    // 不传 cosignAvailable → 走 probeCosign；runner 让 `cosign version` 失败，
    // 于是必须报错并告警（绝不因 T11 缺省 true 而静默"验签成功"）。
    await assertRejects(
      () =>
        install({
          dir,
          repository: REPO,
          ref: REF,
          io: makeIO([], []),
          runner: makeRunner(records, (cmd) =>
            cmd === "cosign"
              ? { code: 127, stdout: "", stderr: "not found" }
              : undefined),
          fetcher: makeFetcher([], []),
          nonInteractive: true,
          passphraseFile: passphrase,
          processEnv: {},
          warn: (m) =>
            warnings.push(m),
        }),
      Error,
      "找不到 Cosign",
    );
    assertEquals(
      records.some((r) => r.cmd === "cosign" && r.args[0] === "version"),
      true,
      "缺省必须经 runner 真实探测 cosign（不得硬编码 true）",
    );
    assert(warnings.some((w) => w.includes("找不到 Cosign")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install 非交互 + 已安装但配置不完整：安装前报错，fetch 零、docker 零", async () => {
  // 已安装目录但仍是模板占位值（DOMAIN / POSTGRES_PASSWORD 命中占位黑名单）。
  const dir = await makeInstalledDir({
    DOMAIN: "change-me.example.com",
    POSTGRES_PASSWORD: "change-me-strong-postgres-password",
  });
  try {
    const records: RunnerCall[] = [];
    const calls: string[] = [];
    await assertRejects(
      () =>
        install({
          dir,
          repository: REPO,
          ref: REF,
          io: makeIO([], []),
          runner: makeRunner(records),
          fetcher: makeFetcher(calls, []),
          nonInteractive: true,
          processEnv: {},
          warn: () => {},
        }),
      Error,
      "生产配置校验失败",
    );
    assertEquals(calls, [], "非交互下配置不完整时不得下载资产");
    assertEquals(records, [], "非交互下配置不完整时不得调用 docker");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install 非交互（isTty=true）仍不进入向导：零 readLine，仅校验后报错", async () => {
  const dir = await makeInstalledDir({ DOMAIN: "change-me.example.com" });
  try {
    const events: string[] = [];
    await assertRejects(
      () =>
        install({
          dir,
          repository: REPO,
          ref: REF,
          io: makeIO([], events),
          runner: makeRunner([]),
          fetcher: makeFetcher([], []),
          nonInteractive: true,
          isTty: true,
          processEnv: {},
          warn: () => {},
        }),
      Error,
      "生产配置校验失败",
    );
    assertEquals(
      events.filter((e) => e.startsWith("read:") || e.startsWith("secret:")),
      [],
      "--non-interactive 即便在 TTY 也必须零交互",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("registerCommand：源码运行模式（无 bin/noj-cli）→ 告警且不注册", async () => {
  const root = await Deno.makeTempDir();
  const dir = await makeInstalledDir();
  try {
    const passphrase = join(root, "pp");
    await writePassphraseFile(passphrase);
    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], []),
      runner: makeRunner([]),
      fetcher: makeFetcher([], []),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: {},
      binDir: join(root, "bin"),
      userHome: join(root, "home"),
      warn: () => {},
    });
    assertEquals(result.registration.path, null);
    assert(
      result.registration.warnings.some((w) => w.includes("源码运行模式")),
      "无安装版二进制时必须告警（对照 register_command :98-101）",
    );
    assertEquals(await Deno.stat(join(root, "bin")).catch(() => null), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("install 的保留判定只看 .env.prod 自身：T5 两件套规则已退役（Finding 1 回归守卫）", async () => {
  // 旧实现：只有 .env.prod、没有 compose → 判成"未安装 → 首装缺配置"报错。
  // 新实现（对齐 bash :600-615）：.env.prod 存在即保留，流程继续走到 compose。
  const dir = await Deno.makeTempDir();
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, ENV_FILE), completeEnv());
    await Deno.chmod(join(dir, ENV_FILE), 0o600);
    const calls: string[] = [];
    const records: RunnerCall[] = [];
    const passphrase = join(root, "pp");
    await writePassphraseFile(passphrase);
    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], []),
      runner: makeRunner(records),
      fetcher: makeFetcher(calls, []),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: { NOJ_BACKUP_PASSPHRASE_FILE: passphrase },
      cosignAvailable: () => Promise.resolve(true),
      warn: () => {},
    });
    assertEquals(result.created, false, "有 .env.prod 即非首装");
    assertEquals(calls.length, 4, "未按首装缺配置报错，而是拉资产补齐 compose");
    assertEquals(
      records.some((r) => r.cmd === "docker" && r.args.includes("up")),
      true,
      "必须走到 compose up",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("PRODUCTION_MARKERS：唯一事实源就是 compose + .env.prod（无 production.sh）", () => {
  assertEquals([...PRODUCTION_MARKERS], [
    "docker-compose.prod.yml",
    ".env.prod",
  ]);
  assertEquals(
    PRODUCTION_MARKERS.includes("scripts/deploy/production.sh"),
    false,
  );
});

Deno.test("install 仅有 .env.prod（无 compose）：逐字节保留用户配置，绝不按模板重建（Finding 1）", async () => {
  // review Finding 1 的复现：旧实现用 T5 两件套判定"已安装"，于是"只有 .env.prod"
  // 被判成空目录首装 → seedEnvFile 以 truncate:true 覆盖用户真实配置（数据销毁）。
  // bash initialize_env（:600-603）只要 `-e "$ENV_FILE"` 就保留并 chmod 600。
  const dir = await Deno.makeTempDir();
  const root = await Deno.makeTempDir();
  try {
    const sentinel = "SENTINEL-" + "f".repeat(32);
    const original = completeEnv({
      DOMAIN: "old.test-oj.cn",
      POSTGRES_PASSWORD: sentinel,
    });
    await Deno.writeTextFile(join(dir, ENV_FILE), original);
    await Deno.chmod(join(dir, ENV_FILE), 0o600);
    await makeCliBinary(dir);
    const calls: string[] = [];
    const records: RunnerCall[] = [];
    const events: string[] = [];
    const passphrase = join(root, "pp");
    await writePassphraseFile(passphrase);

    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], events),
      runner: makeRunner(records),
      fetcher: makeFetcher(calls, events),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: { NOJ_BACKUP_PASSPHRASE_FILE: passphrase },
      cosignAvailable: () => Promise.resolve(true),
      socketExists: () => Promise.resolve(true),
      binDir: join(root, "bin"),
      userHome: join(root, "home"),
      warn: () => {},
    });

    // created 表示"是否由模板生成"，此处必须为 false。
    assertEquals(result.created, false);
    // 绝无 seed-env 步骤。
    assertEquals(
      result.steps.some((s) => s.name === "seed-env"),
      false,
      "既有 .env.prod 不得触发 seed-env",
    );
    // 既无 compose 资产 → 首装式 overwrite:false。
    assertEquals(result.steps[0]?.overwrite, false);
    // 关键断言一：哨兵值逐字节仍在。
    const after = await Deno.readTextFile(join(dir, ENV_FILE));
    assertEquals(after, original, "既有 .env.prod 必须逐字节保留");
    assertStringIncludes(after, sentinel);
    // 关键断言二：不是模板 seed（自动生成的随机密钥不会出现在原文件里）。
    assert(
      !after.includes("change-me-strong-postgres-password"),
      "不得被模板覆盖",
    );
    assertEquals(
      calls.length,
      4,
      "缺 compose 时仍须下载 compose + example 及其 .sha256",
    );
    // compose 与模板都已落盘（bootstrap 补自举）。
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), COMPOSE_BODY);
    assertEquals(await Deno.readTextFile(join(dir, ENV_EXAMPLE)), EXAMPLE_BODY);
    assertEquals(
      ((await Deno.stat(join(dir, ENV_FILE))).mode ?? 0) & 0o777,
      0o600,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("install 仅有 .env.prod（无 compose）：已验证配置时 compose 步骤仍可跑通", async () => {
  // 交叉场景：env 已存在 + compose 不存在。校验必须仍然通过（judge=false 时
  // compose 的 judge profile 不参与解析，故不会引用缺失键），且 compose 被下载。
  const dir = await Deno.makeTempDir();
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, ENV_FILE), completeEnv());
    await Deno.chmod(join(dir, ENV_FILE), 0o600);
    const calls: string[] = [];
    const records: RunnerCall[] = [];
    const passphrase = join(root, "pp");
    await writePassphraseFile(passphrase);

    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], []),
      runner: makeRunner(records),
      fetcher: makeFetcher(calls, []),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: { NOJ_BACKUP_PASSPHRASE_FILE: passphrase },
      cosignAvailable: () => Promise.resolve(true),
      warn: () => {},
    });

    assertEquals(result.created, false);
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), COMPOSE_BODY);
    const names = result.steps.map((s) => s.name);
    assert(names.includes("validate"), "校验步骤必须出现");
    assert(names.includes("compose-up"), "compose 启动步骤必须出现");
    assert(!names.includes("seed-env"), "不得 seed");
    // judge=false → 不带 --profile judge。
    assertEquals(
      records
        .filter((r) => r.cmd === "docker")
        .every((r) => !r.args.includes("--profile")),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("install .env.prod 路径存在但不是普通文件 → 显式报错、零副作用（Finding 1）", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, ENV_FILE));
    const calls: string[] = [];
    const records: RunnerCall[] = [];
    await assertRejects(
      () =>
        install({
          dir,
          repository: REPO,
          ref: REF,
          io: makeIO([], []),
          runner: makeRunner(records),
          fetcher: makeFetcher(calls, []),
          nonInteractive: true,
          processEnv: {},
          warn: () => {},
        }),
      Error,
      "生产配置路径不是普通文件",
    );
    assertEquals(calls, [], "非普通文件时不得下载资产");
    assertEquals(records, [], "非普通文件时不得调用 docker");
    assertEquals(
      (await Deno.stat(join(dir, ENV_FILE))).isDirectory,
      true,
      "目录必须原样保留",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install 空目录：仍由模板 seed .env.prod（正常路径回归守卫）", async () => {
  const dir = await Deno.makeTempDir();
  const root = await Deno.makeTempDir();
  try {
    const calls: string[] = [];
    const records: RunnerCall[] = [];
    const passphrase = join(root, "pp");
    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO(["v0.9.5", "oj.test-oj.cn", "y", "", "y", "", "", "y"], []),
      runner: makeRunner(records),
      fetcher: makeFetcher(calls, []),
      isTty: true,
      passphraseFile: passphrase,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(true),
      socketExists: () => Promise.resolve(true),
      binDir: join(root, "bin"),
      userHome: join(root, "home"),
      warn: () => {},
    });
    assertEquals(result.created, true);
    assert(
      result.steps.some((s) => s.name === "seed-env"),
      "空目录必须 seed",
    );
    const text = await Deno.readTextFile(join(dir, ENV_FILE));
    // 模板正文 + 真实随机密钥。
    assertStringIncludes(text, "STORAGE_PROVIDER=s3");
    assert(
      !text.includes("change-me-strong-postgres-password"),
      "占位口令必须被替换",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("install 非交互首装报错清单按 judge 状态条件化（Minor 2）", () => {
  // 未设置 JUDGE_ENABLED = 启用 → 报错清单含 JUDGE_KEYS。
  const enabled = missingConfigError({}).message;
  assertStringIncludes(enabled, "JUDGE_DOCKER_SOCKET");
  assertStringIncludes(enabled, "JUDGE_DOCKER_SOCKET_GID");
  // 显式关闭 → 不得再列 JUDGE_KEYS（否则误导用户填非必需键）。
  const disabled = missingConfigError({ JUDGE_ENABLED: "false" }).message;
  assert(
    !disabled.includes("JUDGE_DOCKER_SOCKET"),
    "judge 关闭时不得列出 JUDGE_KEYS",
  );
  // 核心键仍在。
  assertStringIncludes(disabled, "DOMAIN");
  assertStringIncludes(disabled, "JWT_SECRET");
});

Deno.test("install 升级路径：既有配置完整时不再进入向导（Minor 3 的步骤诚实性）", async () => {
  const dir = await makeInstalledDir();
  const root = await Deno.makeTempDir();
  try {
    const passphrase = join(root, "pp");
    await writePassphraseFile(passphrase);
    const events: string[] = [];
    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], events),
      runner: makeRunner([]),
      fetcher: makeFetcher([], events),
      // TTY 但不非交互：配置已完整 → 向导不应被触发。
      isTty: true,
      passphraseFile: passphrase,
      processEnv: { NOJ_BACKUP_PASSPHRASE_FILE: passphrase },
      cosignAvailable: () => Promise.resolve(true),
      warn: () => {},
    });
    assertEquals(
      events.filter((e) => e.startsWith("read:") || e.startsWith("secret:")),
      [],
      "配置完整时不得有任何交互",
    );
    assertEquals(
      result.steps.some((s) => s.name === "configure"),
      false,
      "没做任何事时不得记录 configure 步骤",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("install 半成品目录（仅有 compose、缺 .env.prod）：允许覆盖重下，不误判为空目录", async () => {
  // 上次安装中途失败留下的 compose：若传 overwrite:false，T9 会拒绝覆盖并让
  // 用户永远无法重试。overwrite 由 T9 自己的资产清单决定。
  const dir = await Deno.makeTempDir();
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, COMPOSE), "stale\n");
    await makeCliBinary(dir);
    const calls: string[] = [];
    const records: RunnerCall[] = [];
    const passphrase = join(root, "pp");
    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO(["v0.9.5", "oj.test-oj.cn", "y", "", "y", "", "", "y"], []),
      runner: makeRunner(records),
      fetcher: makeFetcher(calls, []),
      isTty: true,
      passphraseFile: passphrase,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(true),
      socketExists: () => Promise.resolve(true),
      binDir: join(root, "bin"),
      userHome: join(root, "home"),
      warn: () => {},
    });
    // 覆盖模式生效：compose 被替换为新版本。
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), COMPOSE_BODY);
    assertEquals(result.steps[0]?.overwrite, true);
    // 无既有 .env.prod → 仍按首次安装生成配置。
    assertEquals(result.created, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});
