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
import type { RenderIO } from "../output/render.ts";
import { sha256Hex } from "../util/hash.ts";
import type { Fetcher } from "./bootstrap.ts";
import { PATH_LINE } from "./lifecycle/path.ts";
import {
  install,
  type InstallResult,
  type LifecycleBaseResult,
  type LifecycleOptions,
  logs,
  missingConfigError,
  restart,
  start,
  status,
  stop,
} from "./lifecycle.ts";
import { COMPOSE_CONFIG_INVALID_HINT } from "./lifecycle/steps.ts";
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
    // T13 闭合 T12 的 wait_for_stack 缺口：install 与 start 共用同一实现，
    // 逐字跑 bash 的两段 up（--wait-timeout 180 --remove-orphans + nginx 刷新）。
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
      "--wait-timeout",
      "180",
      "--remove-orphans",
    ]);
    assertEquals(dockerArgs[3], [
      "compose",
      "--env-file",
      envFile,
      "-f",
      composeFile,
      "--profile",
      "judge",
      "up",
      "-d",
      "--force-recreate",
      "--no-deps",
      "nginx",
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
          runner: makeRunner(
            records,
            configOk((cmd) =>
              cmd === "cosign"
                ? { code: 127, stdout: "", stderr: "not found" }
                : undefined
            ),
          ),
          fetcher: makeFetcher([], []),
          nonInteractive: true,
          passphraseFile: passphrase,
          processEnv: {},
          warn: (m) => warnings.push(m),
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

// ---------------- T13：start / stop / restart / status（接线 T4 状态机） ----------------
//
// 全部使用注入 runner：永不触碰真实 docker；所有输出经注入的 RenderIO，
// 不写真实 stdout/stderr。

/** docker compose ps 表头（列间以多空格对齐，模拟 compose 的 tabwriter）。 */
const PS_HEADER =
  "NAME                IMAGE               COMMAND                  SERVICE    CREATED         STATUS                   PORTS";

/** 构造一行 compose ps 输出（固定列宽，状态列对齐表头 STATUS 字符位）。 */
function psRow(name: string, service: string, status: string): string {
  return name.padEnd(20) +
    "ghcr.io/noj/x".padEnd(20) +
    '"/entrypoint"'.padEnd(25) +
    service.padEnd(11) +
    "2 hours ago".padEnd(16) +
    status;
}

/** 全 Up：T4 prodState → running。 */
const PS_RUNNING = [
  PS_HEADER,
  psRow("noj-core-1", "core", "Up 2 hours (healthy)"),
  psRow("noj-postgres-1", "postgres", "Up 2 hours (healthy)"),
].join("\n") + "\n";

/** 部分运行：T4 prodState → partial。 */
const PS_PARTIAL = [
  PS_HEADER,
  psRow("noj-core-1", "core", "Up 2 hours (healthy)"),
  psRow("noj-postgres-1", "postgres", "Exited (0) 3 minutes ago"),
].join("\n") + "\n";

/** 全 Exited：T4 prodState → stopped。 */
const PS_STOPPED = [
  PS_HEADER,
  psRow("noj-core-1", "core", "Exited (1) 2 minutes ago"),
  psRow("noj-postgres-1", "postgres", "Exited (0) 3 minutes ago"),
].join("\n") + "\n";

/** 捕获 T6/T8 两个输出通道；测试绝不写真实 stdout/stderr。 */
function captureRenderIO(json = false): {
  io: RenderIO;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (s) => void stdout.push(s),
      stderr: (s) => void stderr.push(s),
      jsonMode: json,
    },
    stdout,
    stderr,
  };
}

/** 测试固定 --color=never，输出无 ANSI，断言可逐字比较。 */
const NO_COLOR = "never" as const;

/**
 * judge socket 存在探针：judge 启用时 T11 `checkJudgeSocket` 要求 socket 存在。
 * 注入后测试无需真实 `/var/run/…`，也不因环境差异漂移。
 */
const SOCKET_PRESENT = () => Promise.resolve(true);

/** 让 compose ps 返回固定输出的 override。 */
function psOverride(
  output: string,
  code = 0,
): (cmd: string, args: string[]) => Partial<CmdResult> | undefined {
  return (cmd, args) =>
    cmd === "docker" && args.includes("ps")
      ? { code, stdout: output, stderr: "" }
      : undefined;
}

/** 该次调用是否为某个 compose 子命令。 */
function hasSub(record: RunnerCall, sub: string): boolean {
  return record.cmd === "docker" && record.args.includes(sub);
}

/**
 * 默认 fake：`compose config` 视为通过，其余命令由 `overrides` 决定。
 *
 * `prepareAndCheck`（T13 评审 Important）现在会对所有命令跑 `compose config`，
 * 因此测试的 compose 结果判定必须先放行 config；只关心特定子命令（如 `ps`）
 * 的用例无需重复声明。
 */
function configOk(
  overrides: (cmd: string, args: string[]) => Partial<CmdResult> | undefined,
): (cmd: string, args: string[]) => Partial<CmdResult> | undefined {
  return (cmd, args) => {
    if (cmd === "docker" && args.includes("config")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    return overrides(cmd, args);
  };
}

/** 四个生命周期命令的公共签名（前置校验测试用）。 */
type LifecycleFn = (opts: LifecycleOptions) => Promise<LifecycleBaseResult>;

Deno.test("status：全 Up → running（T4 prodState），退出码 0", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stdout } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.state, "running");
    assertEquals(result.exitCode, 0);
    assertEquals(result.error, null);
    assertEquals(result.psOutput, PS_RUNNING);
    const text = stdout.join("");
    assertStringIncludes(text, "✓ 生产服务运行中（running）");
    // 人类输出必须保留 compose ps 原表（对照 bash status）
    assertStringIncludes(text, PS_HEADER);
    assertStringIncludes(text, "noj-core-1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status：混合 → partial，退出码 0", async () => {
  const dir = await makeInstalledDir();
  try {
    const { io, stdout } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner([], configOk(psOverride(PS_PARTIAL))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.state, "partial");
    assertEquals(result.exitCode, 0);
    assertStringIncludes(stdout.join(""), "! 生产服务部分运行（partial）");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status：全 Exited → stopped，退出码 0", async () => {
  const dir = await makeInstalledDir();
  try {
    const { io, stdout } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner([], configOk(psOverride(PS_STOPPED))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.state, "stopped");
    assertEquals(result.exitCode, 0);
    assertStringIncludes(stdout.join(""), "ℹ 生产服务未运行（stopped）");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status：空 ps 输出 → stopped（不写任何 ps 行）", async () => {
  const dir = await makeInstalledDir();
  try {
    const { io, stdout } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner([], configOk(psOverride(""))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.state, "stopped");
    assertEquals(result.psOutput, "");
    assertEquals(result.exitCode, 0);
    assert(
      !stdout.join("").includes(PS_HEADER),
      "空 ps 输出不得写出表头",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status --json：stdout 逐字节为合法 JSON（人类输出改道 stderr）", async () => {
  const dir = await makeInstalledDir();
  try {
    const { io, stdout, stderr } = captureRenderIO(true);
    const result = await status({
      dir,
      runner: makeRunner([], configOk(psOverride(PS_PARTIAL))),
      socketExists: SOCKET_PRESENT,
      io,
      args: ["--json"],
      color: NO_COLOR,
    });
    assertEquals(result.state, "partial");
    // 唯一 stdout 内容 = 一个 JSON 文档：无 ANSI、无中文装饰、无 ps 表
    assertEquals(
      stdout.join(""),
      JSON.stringify({ dir, state: "partial", ps: PS_PARTIAL }, null, 2) + "\n",
    );
    assertStringIncludes(stderr.join(""), "生产服务部分运行（partial）");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("start：已 running → no-op（不调用 up），文案取自 T4 状态机", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stdout } = captureRenderIO();
    const result = await start({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.noOp, true);
    assertEquals(result.state, "running");
    assertEquals(result.exitCode, 0);
    assertEquals(
      records.some((r) => hasSub(r, "up")),
      false,
      "running 时必须 no-op：不得重复执行 compose up",
    );
    // 文案必须逐字来自 T4 transition(state, up).message
    assertStringIncludes(stdout.join(""), "已处于 running，无需重复启动");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("start：stopped → wait_for_stack 两段 up（参数逐元素精确）", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await start({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_STOPPED))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.state, "running");
    assertEquals(result.noOp, false);
    const envFile = join(dir, ENV_FILE);
    const composeFile = join(dir, COMPOSE);
    const ups = records.filter((r) => hasSub(r, "up")).map((r) => r.args);
    assertEquals(ups, [
      [
        "compose",
        "--env-file",
        envFile,
        "-f",
        composeFile,
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "180",
        "--remove-orphans",
      ],
      [
        "compose",
        "--env-file",
        envFile,
        "-f",
        composeFile,
        "up",
        "-d",
        "--force-recreate",
        "--no-deps",
        "nginx",
      ],
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stop：已 stopped → no-op（不调用 stop）", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stdout } = captureRenderIO();
    const result = await stop({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_STOPPED))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.noOp, true);
    assertEquals(result.state, "stopped");
    assertEquals(result.exitCode, 0);
    assertEquals(
      records.some((r) => hasSub(r, "stop")),
      false,
      "stopped 时必须 no-op",
    );
    assertStringIncludes(stdout.join(""), "已处于 stopped，无需重复关闭");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stop：running → compose stop，且绝不使用 down/-v（数据卷保留）", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await stop({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.state, "stopped");
    assertEquals(result.noOp, false);
    const stopCall = records.find((r) => hasSub(r, "stop"));
    assert(stopCall !== undefined, "running 时必须执行 compose stop");
    assertEquals(stopCall.args, [
      "compose",
      "--env-file",
      join(dir, ENV_FILE),
      "-f",
      join(dir, COMPOSE),
      "stop",
    ]);
    assertEquals(
      records.some((r) =>
        r.args.includes("-v") || r.args.includes("--volumes") ||
        r.args.includes("down")
      ),
      false,
      "stop 绝不得使用 down/-v/--volumes（数据卷必须保留）",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("restart：先 stop 再 up（顺序断言）", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    let psCalls = 0;
    const result = await restart({
      dir,
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      runner: makeRunner(
        records,
        configOk((cmd, args) => {
          if (cmd === "docker" && args.includes("ps")) {
            psCalls++;
            // 第一次（stop 前）→ running；第二次（start 前）→ 已停止。
            return {
              code: 0,
              stdout: psCalls === 1 ? PS_RUNNING : PS_STOPPED,
              stderr: "",
            };
          }
          return undefined;
        }),
      ),
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.state, "running");
    const idxStop = records.findIndex((r) => hasSub(r, "stop"));
    const idxUp = records.findIndex((r) => hasSub(r, "up"));
    assert(idxStop >= 0, "restart 必须先停止");
    assert(idxUp > idxStop, "restart 必须在停止之后再启动");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("wait_for_stack：首段 up 失败 → 退出码 1 + status/logs 提示（bash fail 文案）", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stderr } = captureRenderIO();
    const result = await start({
      dir,
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      runner: makeRunner(
        records,
        configOk((cmd, args) => {
          if (cmd === "docker" && args.includes("ps")) {
            return { code: 0, stdout: PS_STOPPED, stderr: "" };
          }
          if (cmd === "docker" && args.includes("up")) {
            return { code: 1, stdout: "", stderr: "healthcheck failed" };
          }
          return undefined;
        }),
      ),
    });
    assertEquals(result.exitCode, 1);
    assertEquals(
      result.error,
      "服务启动或健康检查失败，请执行 status 和 logs 排查",
    );
    assertStringIncludes(stderr.join(""), "请执行 status 和 logs 排查");
    assertEquals(
      records.filter((r) => hasSub(r, "up")).length,
      1,
      "首段失败必须立即中止，不得执行第二段 nginx 刷新",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("wait_for_stack：第二段 nginx 失败 → 退出码 1 + 反向代理刷新提示", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stderr } = captureRenderIO();
    let ups = 0;
    const result = await start({
      dir,
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      runner: makeRunner(
        records,
        configOk((cmd, args) => {
          if (cmd === "docker" && args.includes("ps")) {
            return { code: 0, stdout: PS_STOPPED, stderr: "" };
          }
          if (cmd === "docker" && args.includes("up")) {
            ups++;
            return ups === 1
              ? { code: 0, stdout: "", stderr: "" }
              : { code: 1, stdout: "", stderr: "nginx boom" };
          }
          return undefined;
        }),
      ),
    });
    assertEquals(result.exitCode, 1);
    assertEquals(result.error, "反向代理刷新失败，请执行 status 和 logs 排查");
    assertStringIncludes(stderr.join(""), "反向代理刷新失败");
    assertEquals(records.filter((r) => hasSub(r, "up")).length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status：compose ps 非 0 → 退出码 1", async () => {
  const dir = await makeInstalledDir();
  try {
    const { io, stderr } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner([], configOk(psOverride("", 1))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 1);
    assert(result.error !== null);
    assertStringIncludes(stderr.join(""), "compose ps");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置：.env.prod 权限非 600/400 → 四个命令均拒绝且零 docker 调用", async () => {
  const dir = await makeInstalledDir({}, 0o644);
  try {
    const commands: ReadonlyArray<[string, LifecycleFn]> = [
      ["start", start],
      ["stop", stop],
      ["restart", restart],
      ["status", status],
    ];
    for (const [name, fn] of commands) {
      const records: RunnerCall[] = [];
      const { io } = captureRenderIO();
      const result = await fn({
        dir,
        runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
        socketExists: SOCKET_PRESENT,
        io,
        color: NO_COLOR,
      });
      assertEquals(result.exitCode, 1, name + " 必须拒绝不合格权限");
      assertStringIncludes(
        result.error ?? "",
        "生产配置文件权限必须为 600 或 400",
      );
      assertEquals(records, [], name + " 权限不合格时不得调用 docker");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置：缺必需配置 → 报错（复用 T11 缺失清单），零 docker 调用", async () => {
  const dir = await makeInstalledDir({ DOMAIN: "", JWT_SECRET: "" });
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "生产配置校验失败");
    assertStringIncludes(result.error ?? "", "DOMAIN");
    assertStringIncludes(result.error ?? "", "JWT_SECRET");
    assertEquals(records, [], "配置不合格时不得调用 docker");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------- T13 评审 Important：check_configuration 六步共享前置 ----------------
//
// prepareAndCheck 现在对**所有**生命周期命令与 install 跑 bash check_configuration
// 的六步（env 文件 / 权限 / 必填值 / judge socket / 端口 / compose config）。
// 以下测试锁定新增的第 4/5/6 步及其零副作用顺序。

Deno.test("前置（步骤 4）：judge 启用 → socket 检查执行（注入探针被调用）", async () => {
  // completeEnv 默认 JUDGE_ENABLED=false；显式改 true 才会走 check_judge_socket。
  // judge 启用时 T2 的 validateEnv 也要求 socket 键非占位，故一并给出。
  const dir = await makeInstalledDir({
    JUDGE_ENABLED: "true",
    JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock",
    JUDGE_DOCKER_SOCKET_GID: "10001",
  });
  try {
    const probed: string[] = [];
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: (path) => {
        probed.push(path);
        return Promise.resolve(true);
      },
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(probed.length, 1, "judge 启用时 socket 探针必须被调用一次");
    // judge=true → compose 调用必须带 --profile judge（socket 检查通过后照常执行）。
    assert(
      records.some((r) => r.args.includes("--profile")),
      "judge 启用时后续 compose 调用必须带 --profile judge",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置（步骤 4）：judge 关闭 → 跳过 socket 检查（bash 的「已跳过」分支）", async () => {
  const dir = await makeInstalledDir({ JUDGE_ENABLED: "false" });
  try {
    let calls = 0;
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: () => {
        calls++;
        return Promise.resolve(true);
      },
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 0);
    // bash：judge_enabled 为假 → ok "已跳过 Judge Docker socket 检查"，不探 socket。
    assertEquals(calls, 0, "judge 关闭时不得探测 socket");
    assertEquals(
      records.some((r) => r.args.includes("--profile")),
      false,
      "judge 关闭时不得带 --profile judge",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置（步骤 4）：judge 启用但 socket 不存在 → 报错且零 docker 调用", async () => {
  const dir = await makeInstalledDir({
    JUDGE_ENABLED: "true",
    JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock",
    JUDGE_DOCKER_SOCKET_GID: "10001",
  });
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: () => Promise.resolve(false),
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "Judge 隔离 Docker socket 不存在");
    assertEquals(records, [], "socket 检查失败必须早于任何 docker 调用");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置（步骤 5）：NGINX_PORT 取值非法 → 报错且零 docker 调用", async () => {
  const dir = await makeInstalledDir({ NGINX_PORT: "70000" });
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 1);
    assertEquals(result.error, "NGINX_PORT 必须是 1-65535 的端口号");
    assertEquals(records, [], "端口非法时必须早于任何 docker 调用");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置（步骤 5）：端口探测注入 → 冲突告警但**不**阻断命令", async () => {
  const dir = await makeInstalledDir({ NGINX_PORT: "8080" });
  try {
    const probed: number[] = [];
    const { io, stdout } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner([], configOk(psOverride(PS_RUNNING))),
      socketExists: SOCKET_PRESENT,
      probePort: (port) => {
        probed.push(port);
        return Promise.resolve(true);
      },
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 0, "端口冲突只是告警，不得阻断");
    assertEquals(probed, [8080]);
    assertStringIncludes(stdout.join(""), "NGINX_PORT=8080 已被其他进程监听");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置（步骤 6）：compose config 失败 → 报错文案含 compose 无效提示，且零变更命令", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stderr } = captureRenderIO();
    const result = await start({
      dir,
      runner: makeRunner(records, (cmd, args) => {
        if (cmd === "docker" && args.includes("config")) {
          return { code: 1, stdout: "", stderr: "service 'core' has no image" };
        }
        return undefined;
      }),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(
      result.error ?? "",
      "Docker Compose 配置无效，请检查环境变量和生产 Compose 文件",
    );
    assertStringIncludes(result.error ?? "", "service 'core' has no image");
    assertStringIncludes(stderr.join(""), "Docker Compose 配置无效");
    // compose config 是唯一的 docker 调用：失败后绝不进入 up（零变更命令）。
    assertEquals(records.filter((r) => hasSub(r, "config")).length, 1);
    assertEquals(
      records.filter((r) => hasSub(r, "up") || hasSub(r, "stop")).length,
      0,
      "compose config 失败后不得执行任何变更命令",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置（顺序）：compose config 失败早于任何 up/stop/down（四个命令同断言）", async () => {
  const dir = await makeInstalledDir();
  try {
    const commands: ReadonlyArray<[string, LifecycleFn]> = [
      ["start", start],
      ["stop", stop],
      ["restart", restart],
      ["status", status],
    ];
    for (const [name, fn] of commands) {
      const records: RunnerCall[] = [];
      const { io } = captureRenderIO();
      const result = await fn({
        dir,
        // 只让 config 失败；ps 也故意返回 running，若不前置校验就会执行 stop/up。
        runner: makeRunner(records, (cmd, args) => {
          if (cmd === "docker" && args.includes("config")) {
            return { code: 1, stdout: "", stderr: "invalid compose" };
          }
          return { code: 0, stdout: PS_RUNNING, stderr: "" };
        }),
        socketExists: SOCKET_PRESENT,
        io,
        color: NO_COLOR,
      });
      assertEquals(result.exitCode, 1, name + " 必须因前置校验失败而拒绝");
      assertStringIncludes(result.error ?? "", "Docker Compose 配置无效");
      const mutating = records.filter((r) =>
        hasSub(r, "up") || hasSub(r, "stop") || hasSub(r, "down")
      );
      assertEquals(
        mutating,
        [],
        name + " 前置校验失败时不得记录任何变更命令（up/stop/down）",
      );
      assertEquals(
        records.filter((r) => hasSub(r, "config")).length,
        1,
        name + " 必须先且只跑一次 compose config",
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置（步骤 6）：install 与生命周期命令共享同一 compose config 文案", async () => {
  const dir = await makeInstalledDir();
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
          runner: makeRunner(records, (cmd, args) => {
            if (cmd === "docker" && args.includes("config")) {
              return { code: 1, stdout: "", stderr: "invalid compose" };
            }
            return undefined;
          }),
          fetcher: makeFetcher([], []),
          nonInteractive: true,
          passphraseFile: passphrase,
          processEnv: { NOJ_BACKUP_PASSPHRASE_FILE: passphrase },
          cosignAvailable: () => Promise.resolve(true),
          socketExists: SOCKET_PRESENT,
          warn: () => {},
        }),
      Error,
      COMPOSE_CONFIG_INVALID_HINT,
    );
    assertEquals(
      records.filter((r) => hasSub(r, "config")).length,
      1,
      "install 的 validate 步骤必须跑一次 compose config",
    );
    assertEquals(
      records.filter((r) => hasSub(r, "up")).length,
      0,
      "install 的 compose config 失败后不得进入 up",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置：缺少 .env.prod → 明确报错（请先执行 install）", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, COMPOSE), COMPOSE_BODY);
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "找不到生产配置");
    assertStringIncludes(result.error ?? "", "请先执行 install");
    assertEquals(records, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------- T14：logs（颜色契约 + --follow） ----------------
//
// 着色优先级逐条对照 deploy.sh:1136-1154；进程环境经 withLogEnv 临时置值
// （与 util/color_test.ts 同法），用例结束即恢复，不污染其他测试。
// 全部注入 runner：缓冲路径走 run、实时路径走 stream，绝不触真实 docker。

/**
 * 临时设置/清除 `LOG_COLOR` / `NO_COLOR` 两个进程环境变量，结束后恢复。
 *
 * 未在 `env` 中给出的键会被**清除**，因此断言不会被运行环境里的残留变量
 * 污染（`NO_COLOR=1` 是常见 CI 变量）。
 */
async function withLogEnv<T>(
  env: { LOG_COLOR?: string; NO_COLOR?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const keys = ["LOG_COLOR", "NO_COLOR"] as const;
  const saved = new Map<string, string | undefined>(
    keys.map((k) => [k, Deno.env.get(k)]),
  );
  for (const k of keys) {
    const value = env[k];
    if (value === undefined) Deno.env.delete(k);
    else Deno.env.set(k, value);
  }
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      const value = saved.get(k);
      if (value === undefined) Deno.env.delete(k);
      else Deno.env.set(k, value);
    }
  }
}

/** logs 专用 fake：分别记录缓冲（run）与实时（stream）两条路径。 */
function makeLogsRunner(
  options: {
    stdout?: string;
    stderr?: string;
    code?: number;
    streamLines?: string[];
    streamCode?: number;
  } = {},
): {
  runner: CommandRunner;
  runs: RunnerCall[];
  streams: RunnerCall[];
  events: string[];
} {
  const runs: RunnerCall[] = [];
  const streams: RunnerCall[] = [];
  const events: string[] = [];
  const runner: CommandRunner = {
    run(cmd, args) {
      runs.push({ cmd, args: [...args] });
      // compose config 是 prepareAndCheck 的第 6 步；logs 命令的断言要能
      // 区分「前置校验」与「真正的日志调用」，故在时间轴上打点。
      events.push(
        cmd === "docker" && args.includes("logs")
          ? "run:logs"
          : "run:" + args.join(" "),
      );
      const isLogs = cmd === "docker" && args.includes("logs");
      return Promise.resolve({
        code: isLogs ? (options.code ?? 0) : 0,
        stdout: isLogs ? (options.stdout ?? "") : "",
        stderr: isLogs ? (options.stderr ?? "") : "",
      });
    },
    spawn(): SpawnHandle {
      throw new Error("logs 测试不 spawn");
    },
    stream(cmd, args, onLine) {
      streams.push({ cmd, args: [...args] });
      events.push("stream:logs");
      for (const line of options.streamLines ?? []) onLine(line);
      return Promise.resolve(options.streamCode ?? 0);
    },
  };
  return { runner, runs, streams, events };
}

/** 取 `compose logs` 调用的完整参数数组（不存在即抛错，避免空断言）。 */
function logsCall(calls: RunnerCall[]): string[] {
  const hit = calls.find((c) => c.cmd === "docker" && c.args.includes("logs"));
  if (hit === undefined) throw new Error("没有 compose logs 调用");
  return hit.args;
}

/** 断言全局 `--ansi always` 出现在 `logs` 子命令**之前**（而非追加在其后）。 */
function assertForcedAnsi(args: string[]): void {
  const ansi = args.indexOf("--ansi");
  const sub = args.indexOf("logs");
  assert(ansi !== -1, "缺少全局 --ansi：" + args.join(" "));
  assert(sub !== -1, "缺少 logs 子命令：" + args.join(" "));
  assert(ansi < sub, "--ansi always 必须排在子命令之前：" + args.join(" "));
  assertEquals(args[ansi + 1], "always");
  assertEquals(args.includes("--no-color"), false);
}

Deno.test("logs 着色优先级：进程 env LOG_COLOR=always 覆盖 .env.prod 的 never → 强制 --ansi always", async () => {
  const dir = await makeInstalledDir({ LOG_COLOR: "never" });
  try {
    const { runner, runs } = makeLogsRunner({ stdout: "line-1\n" });
    const { io } = captureRenderIO();
    const result = await withLogEnv(
      { LOG_COLOR: "always" },
      () => logs({ dir, runner, io, color: NO_COLOR }),
    );
    assertEquals(result.exitCode, 0);
    assertEquals(result.colorDecision, "force");
    assertForcedAnsi(logsCall(runs));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs 着色优先级：进程 env 未设 → 回退 .env.prod 的 LOG_COLOR=always", async () => {
  const dir = await makeInstalledDir({ LOG_COLOR: "always" });
  try {
    const { runner, runs } = makeLogsRunner({ stdout: "line-1\n" });
    const { io } = captureRenderIO();
    const result = await withLogEnv(
      {},
      () => logs({ dir, runner, io, color: NO_COLOR }),
    );
    assertEquals(result.exitCode, 0);
    assertEquals(result.colorDecision, "force");
    assertForcedAnsi(logsCall(runs));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs 着色优先级：进程 env LOG_COLOR=never 覆盖 .env.prod 的 always", async () => {
  const dir = await makeInstalledDir({ LOG_COLOR: "always" });
  try {
    const { runner, runs } = makeLogsRunner({ stdout: "line-1\n" });
    const { io } = captureRenderIO();
    const result = await withLogEnv(
      { LOG_COLOR: "never" },
      () => logs({ dir, runner, io, color: NO_COLOR }),
    );
    assertEquals(result.colorDecision, "no-color");
    const args = logsCall(runs);
    assertEquals(args.includes("--no-color"), true);
    assertEquals(args.includes("--ansi"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('logs 着色：LOG_COLOR 去空白 + 小写归一（" ALWAYS " → always）', async () => {
  const dir = await makeInstalledDir({ LOG_COLOR: " Never " });
  try {
    const { io } = captureRenderIO();
    // 进程 env（首尾空白 + 大写）优先于 .env.prod 的 " Never "
    const envCase = makeLogsRunner({ stdout: "line-1\n" });
    const forced = await withLogEnv(
      { LOG_COLOR: " ALWAYS " },
      () => logs({ dir, runner: envCase.runner, io, color: NO_COLOR }),
    );
    assertEquals(forced.colorDecision, "force");
    assertForcedAnsi(logsCall(envCase.runs));

    // 进程 env 未设 → .env.prod 的 " Never " 同样归一为 never
    const fileCase = makeLogsRunner({ stdout: "line-1\n" });
    const fileOnly = await withLogEnv(
      {},
      () => logs({ dir, runner: fileCase.runner, io, color: NO_COLOR }),
    );
    assertEquals(fileOnly.colorDecision, "no-color");
    assertEquals(logsCall(fileCase.runs).includes("--no-color"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs 分支顺序：NO_COLOR 非空 → --no-color，即使 LOG_COLOR=always", async () => {
  const dir = await makeInstalledDir();
  const envDir = await makeInstalledDir({ LOG_COLOR: "always", NO_COLOR: "1" });
  try {
    const { io } = captureRenderIO();

    // 进程 env 同时给出：NO_COLOR 分支在前（bash 逐字顺序）
    const envCase = makeLogsRunner({ stdout: "line-1\n" });
    const envResult = await withLogEnv(
      { NO_COLOR: "1", LOG_COLOR: "always" },
      () => logs({ dir, runner: envCase.runner, io }),
    );
    assertEquals(envResult.colorDecision, "no-color");
    assertEquals(logsCall(envCase.runs).includes("--no-color"), true);
    assertEquals(logsCall(envCase.runs).includes("--ansi"), false);

    // .env.prod 同时给出：同样 NO_COLOR 优先
    const fileCase = makeLogsRunner({ stdout: "line-1\n" });
    const fileResult = await withLogEnv(
      {},
      () => logs({ dir: envDir, runner: fileCase.runner, io }),
    );
    assertEquals(fileResult.colorDecision, "no-color");
    assertEquals(logsCall(fileCase.runs).includes("--no-color"), true);
    assertEquals(logsCall(fileCase.runs).includes("--ansi"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(envDir, { recursive: true });
  }
});

Deno.test("logs 重定向安全：NO_COLOR=1 强制关色 → --no-color，且自身输出不含 ANSI", async () => {
  const dir = await makeInstalledDir();
  try {
    const { runner, runs } = makeLogsRunner({ stdout: "line-1\n" });
    const { io, stdout, stderr } = captureRenderIO();
    // 断言必须**无条件执行**：显式给进程 env 的 NO_COLOR，使判定与
    // 运行器是否 TTY 无关（否则交互式 runner 下整条断言变成 no-op）。
    const result = await withLogEnv(
      { NO_COLOR: "1" },
      () => logs({ dir, runner, io }),
    );
    assertEquals(result.exitCode, 0);
    assertEquals(result.colorDecision, "no-color");
    assertEquals(logsCall(runs).includes("--no-color"), true);
    assertEquals(logsCall(runs).includes("--ansi"), false);
    // `noj-cli logs core > out.txt` 的等价场景：不得把 ANSI 写进重定向文件。
    for (const chunk of [...stdout, ...stderr]) {
      assertEquals(chunk.includes("\x1b["), false, "重定向输出不得含 ANSI");
    }
    assertStringIncludes(stdout.join(""), "line-1\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs 重定向安全：非 TTY 的 auto 路径 → --no-color（TTY 下为 inherit）", async () => {
  const dir = await makeInstalledDir();
  try {
    const { runner, runs } = makeLogsRunner({ stdout: "line-1\n" });
    const { io } = captureRenderIO();
    const result = await withLogEnv({}, () => logs({ dir, runner, io }));
    assertEquals(result.exitCode, 0);
    // 无任何色旗输入时，判定 = stdout 是否 TTY（bash `[[ -t 1 ]]`）：
    // 非 TTY（测试进程前提，与 util/color_test.ts 同一前提）→ no-color；
    // TTY → inherit（不传色旗，交回 compose 自行探测）。
    const expected = Deno.stdout.isTerminal() ? "inherit" : "no-color";
    assertEquals(result.colorDecision, expected);
    assertEquals(
      logsCall(runs).includes("--no-color"),
      expected === "no-color",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs core --follow：走 stream（实时），参数为 --tail=200 --follow core", async () => {
  const dir = await makeInstalledDir();
  try {
    const { runner, runs, streams } = makeLogsRunner({
      streamLines: ["a", "b"],
    });
    const { io, stdout } = captureRenderIO();
    const result = await withLogEnv({ LOG_COLOR: "always" }, () =>
      logs({
        dir,
        runner,
        io,
        color: NO_COLOR,
        services: ["core"],
        follow: true,
      }));
    assertEquals(result.exitCode, 0);
    assertEquals(result.followed, true);
    assertEquals(result.colorDecision, "force");
    // 实时跟随走 stream，缓冲的 run 不接 logs（run 无法实时输出）
    assertEquals(streams.length, 1);
    assertEquals(
      runs.some((r) => r.args.includes("logs")),
      false,
      "实时跟随不得走缓冲 run",
    );
    const args = streams[0]!.args;
    assertForcedAnsi(args);
    // 子命令之后：--tail=200 --follow <services>（强制着色走全局 --ansi，故无色旗）
    assertEquals(
      args.slice(args.indexOf("logs")),
      ["logs", "--tail=200", "--follow", "core"],
    );
    // 实时逐行写 stdout（runner 不打印，由命令自己写）
    assertEquals(stdout.join("").endsWith("a\nb\n"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs 非 follow：走缓冲 run，stdout 原样写 stdout、stderr 原样转 stderr", async () => {
  const dir = await makeInstalledDir();
  try {
    const { runner, runs, streams } = makeLogsRunner({
      stdout: "line-1\n",
      stderr: "warn-1\n",
    });
    const { io, stdout, stderr } = captureRenderIO();
    const result = await withLogEnv(
      {},
      () => logs({ dir, runner, io, color: NO_COLOR }),
    );
    assertEquals(result.exitCode, 0);
    assertEquals(result.followed, false);
    assertEquals(streams, []);
    assertEquals(runs.filter((r) => r.args.includes("logs")).length, 1);
    assertEquals(stdout.join("").endsWith("line-1\n"), true);
    assertStringIncludes(stderr.join(""), "warn-1\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs --json：stdout 逐字节为合法 JSON，日志与诊断改道 stderr", async () => {
  const dir = await makeInstalledDir();
  try {
    const { runner } = makeLogsRunner({ stdout: "line-1\n" });
    const { io, stdout, stderr } = captureRenderIO(true);
    const result = await withLogEnv(
      {},
      () => logs({ dir, runner, io, color: NO_COLOR, args: ["--json"] }),
    );
    assertEquals(result.exitCode, 0);
    assertEquals(
      stdout.join(""),
      JSON.stringify(
        {
          dir,
          services: [],
          colorDecision: "no-color",
          followed: false,
          error: null,
        },
        null,
        2,
      ) + "\n",
    );
    assertStringIncludes(stderr.join(""), "line-1\n");
    assertEquals(stdout.join("").includes("\x1b["), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs：compose logs 非 0 → 退出码 1，诊断写 stderr", async () => {
  const dir = await makeInstalledDir();
  try {
    const { runner } = makeLogsRunner({ stderr: "boom\n", code: 2 });
    const { io, stderr } = captureRenderIO();
    const result = await withLogEnv(
      {},
      () => logs({ dir, runner, io, color: NO_COLOR }),
    );
    assertEquals(result.exitCode, 1);
    assertEquals(result.error !== null, true);
    assertStringIncludes(stderr.join(""), "boom");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs：前置校验失败 → 退出码 1 且零 compose logs 调用", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, COMPOSE), COMPOSE_BODY);
    const { runner, runs } = makeLogsRunner();
    const { io, stderr } = captureRenderIO();
    const result = await withLogEnv(
      {},
      () => logs({ dir, runner, io, color: NO_COLOR }),
    );
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "找不到生产配置");
    assertEquals(runs.filter((r) => r.args.includes("logs")), []);
    assertStringIncludes(stderr.join(""), "找不到生产配置");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs core：服务名透传，且 --no-color 排在服务名之前、--tail=200 之后", async () => {
  const dir = await makeInstalledDir();
  try {
    const { runner, runs } = makeLogsRunner({ stdout: "line-1\n" });
    const { io } = captureRenderIO();
    const result = await withLogEnv(
      {},
      () =>
        logs({ dir, runner, io, color: NO_COLOR, services: ["core", "nginx"] }),
    );
    assertEquals(result.exitCode, 0);
    assertEquals(
      logsCall(runs),
      [
        "compose",
        "--env-file",
        join(dir, ENV_FILE),
        "-f",
        join(dir, COMPOSE),
        "logs",
        "--tail=200",
        "--no-color",
        "core",
        "nginx",
      ],
      "--no-color 必须在 --tail 之后、服务名之前（bash args 追加顺序）",
    );
    assertEquals(result.services, ["core", "nginx"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs：进程 env 的 LOG_COLOR 为空串 → 回退 .env.prod（对齐 bash 的 -z 判定）", async () => {
  const dir = await makeInstalledDir({ LOG_COLOR: "always" });
  try {
    const { runner, runs } = makeLogsRunner({ stdout: "line-1\n" });
    const { io } = captureRenderIO();
    const result = await withLogEnv(
      { LOG_COLOR: "" },
      () => logs({ dir, runner, io, color: NO_COLOR }),
    );
    assertEquals(result.colorDecision, "force");
    assertForcedAnsi(logsCall(runs));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs --follow 非 0：退出码 1，且诊断走 stderr", async () => {
  const dir = await makeInstalledDir();
  try {
    const { runner, streams } = makeLogsRunner({
      streamLines: ["a"],
      streamCode: 3,
    });
    const { io, stderr } = captureRenderIO();
    const result = await withLogEnv({}, () =>
      logs({
        dir,
        runner,
        io,
        color: NO_COLOR,
        services: ["core"],
        follow: true,
      }));
    assertEquals(result.exitCode, 1);
    assertEquals(streams.length, 1);
    assertStringIncludes(stderr.join(""), "查看生产服务日志失败");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs --follow：runner 无 stream 能力 → 报错而非静默降级为缓冲", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stderr } = captureRenderIO();
    const result = await withLogEnv({}, () =>
      logs({
        dir,
        // makeRunner 只实现 run / spawn（P2 既有形状），没有 stream。
        runner: makeRunner(records, configOk(() => undefined)),
        io,
        color: NO_COLOR,
        follow: true,
      }));
    assertEquals(result.exitCode, 1);
    assertEquals(
      records.some((r) => r.args.includes("logs")),
      false,
      "不得降级为缓冲调用（那样 --follow 永不返回）",
    );
    assertStringIncludes(stderr.join(""), "不支持实时日志");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
