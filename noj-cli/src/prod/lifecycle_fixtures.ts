/**
 * 生产生命周期测试：共享夹具（注入 runner / fetcher / IO 与安装目录构造）。
 *
 * 全部注入 runner / fetcher / IO，永不触碰真实 docker 与网络。
 */
import { join } from "@std/path";
import type {
  CmdResult,
  CommandRunner,
  SpawnHandle,
} from "../runtime/command.ts";
import type { PromptIO } from "../tui/io.ts";
import type { RenderIO } from "../output/render.ts";
import { sha256Hex } from "../util/hash.ts";
import { RELEASE_SET_FILE } from "./bootstrap.ts";
import type { Fetcher } from "./bootstrap.ts";
import type {
  DrainContext,
  DrainLifecycle,
  DrainResult,
} from "./lifecycle/drain.ts";

export const REPO = "https://github.com/Neuro-OJ/neuro-oj";

export const REF = "v0.9.5";

export const COMPOSE = "docker-compose.prod.yml";

/** 模板的 Release 资产名（非点号开头）。 */
export const ENV_EXAMPLE_ASSET = "env.prod.example";

/** 模板落盘后的文件名（安装目录内）。 */
export const ENV_EXAMPLE = ".env.prod.example";

export const ENV_FILE = ".env.prod";

export const encoder = new TextEncoder();

export const COMPOSE_BODY = "services:\n  core:\n    image: noj\n";

export const EXAMPLE_BODY = [
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

export function releaseSetBody(version: string): Uint8Array<ArrayBuffer> {
  const digest = "sha256:" + "a".repeat(64);
  return encoder.encode(
    JSON.stringify({
      schema_version: 1,
      release: version,
      migration_level: "0139",
      protocol_versions: { evaluation: 3, gateway: 3 },
      components: {
        core: { image: "ghcr.io/neuro-oj/noj-server", digest },
        ui: { image: "ghcr.io/neuro-oj/noj-ui", digest },
        judge: { image: "ghcr.io/neuro-oj/noj-judge", digest },
        gateway: { image: "ghcr.io/neuro-oj/noj-llm-gateway", digest },
        evaluator: { image: "ghcr.io/neuro-oj/noj-evaluator-python", digest },
        solution: { image: "ghcr.io/neuro-oj/noj-solution-python", digest },
        solution_ai: { image: "ghcr.io/neuro-oj/noj-solution-ai", digest },
      },
      cli_version: version,
      ide_version: version,
    }) + "\n",
  );
}

export const ASSETS: Record<string, Uint8Array<ArrayBuffer>> = {
  [COMPOSE]: encoder.encode(COMPOSE_BODY),
  [ENV_EXAMPLE_ASSET]: encoder.encode(EXAMPLE_BODY),
};

/** 一次 runner 调用记录。 */
export interface RunnerCall {
  cmd: string;
  args: string[];
}

/**
 * 记录 run 调用的 fake runner；overrides 可让某条命令返回非 0。
 *
 * 同时把调用写进 `events`（同一时间轴），这样「compose 在向导之后」才有可能
 * 用**同一个序列**的索引比较——不同数组的索引不可比。
 */
export function makeRunner(
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
export function makeIO(answers: string[], events: string[]): PromptIO {
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
export function makeFetcher(
  calls: string[],
  events: string[],
  checksumOverrides: Record<string, string> = {},
): Fetcher {
  return async (url: string) => {
    calls.push(url);
    events.push("fetch:" + (url.split("/").pop() ?? ""));
    const name = url.split("/").pop() ?? "";
    const releaseMatch =
      /\/releases\/download\/([^/]+)\/release-set\.json(?:\.sha256)?$/.exec(
        url,
      );
    const releaseBody = releaseMatch === null
      ? undefined
      : releaseSetBody(decodeURIComponent(releaseMatch[1]!));
    if (name.endsWith(".sha256")) {
      const base = name.slice(0, -".sha256".length);
      const override = checksumOverrides[base];
      if (override !== undefined) {
        return new Response(override, { status: 200 });
      }
      const body = base === RELEASE_SET_FILE.asset ? releaseBody : ASSETS[base];
      if (body === undefined) return new Response("missing", { status: 404 });
      return new Response((await sha256Hex(body)) + "  " + base + "\n", {
        status: 200,
      });
    }
    const body = name === RELEASE_SET_FILE.asset ? releaseBody : ASSETS[name];
    return body === undefined
      ? new Response("missing", { status: 404 })
      : new Response(body, { status: 200 });
  };
}

export const HEX = "a".repeat(64);

/** 一份通过 checkRequiredValues 的完整 .env.prod 文本。 */
export function completeEnv(overrides: Record<string, string> = {}): string {
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

/** 建一个「已安装」目录：完整 .env.prod + compose 文件。 */
export async function makeInstalledDir(
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
export async function writePassphraseFile(path: string): Promise<void> {
  await Deno.writeTextFile(path, "e".repeat(64));
  await Deno.chmod(path, 0o600);
}

/** 造出可执行 bin/noj-cli，令 PATH 注册不落进"源码运行模式"分支。 */
export async function makeCliBinary(dir: string): Promise<void> {
  await Deno.mkdir(join(dir, "bin"), { recursive: true });
  await Deno.writeTextFile(join(dir, "bin/noj-cli"), "");
  await Deno.chmod(join(dir, "bin/noj-cli"), 0o755);
}

/** 捕获两个输出通道；测试绝不写真实 stdout/stderr。 */
export function captureRenderIO(json = false): {
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
export const NO_COLOR = "never" as const;

/**
 * judge socket 存在探针：judge 启用时 `checkJudgeSocket` 要求 socket 存在。
 * 注入后测试无需真实 `/var/run/…`，也不因环境差异漂移。
 */
export const SOCKET_PRESENT = () => Promise.resolve(true);

/** 该次调用是否为某个 compose 子命令。 */
export function hasSub(record: RunnerCall, sub: string): boolean {
  return record.cmd === "docker" && record.args.includes(sub);
}

/**
 * 默认 fake：`compose config` 视为通过，其余命令由 `overrides` 决定。
 *
 * `prepareAndCheck`现在会对所有命令跑 `compose config`，
 * 因此测试的 compose 结果判定必须先放行 config；只关心特定子命令（如 `ps`）
 * 的用例无需重复声明。
 */
export function configOk(
  overrides: (cmd: string, args: string[]) => Partial<CmdResult> | undefined,
): (cmd: string, args: string[]) => Partial<CmdResult> | undefined {
  return (cmd, args) => {
    if (cmd === "docker" && args.includes("config")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    return overrides(cmd, args);
  };
}

/**
 * 会把指定命令**抛成 `Deno.errors.NotFound`** 的 runner。
 *
 * 真实 runner 用 `Deno.Command`：二进制不在 PATH 时 `output()` 抛 `NotFound`，
 * **不是**返回非 0；只注入 `code: 127` 的 fake 会掩盖这条真实路径。records 仍记录调用，便于断言"探测确实跑过"。
 */
export function throwingRunner(
  records: RunnerCall[],
  shouldThrow: (cmd: string, args: string[]) => boolean,
): CommandRunner {
  return {
    run(cmd, args) {
      records.push({ cmd, args: [...args] });
      if (shouldThrow(cmd, args)) {
        return Promise.reject(
          new Deno.errors.NotFound(`Failed to spawn '${cmd}'`),
        );
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn(): SpawnHandle {
      throw new Error("uninstall 测试不 spawn");
    },
  };
}

// ---------------- update / upgrade（版本解析 / 备份 / 文件同步 / 健康检查） ----------------
//
// 全部注入：Release 元数据走 fetcher、docker 走 runner、备份与文件
// 同步走注入回调——因此**不触网、不起容器、不改真实配置**。
//
// 本任务的三处关键契约：
// 1. **no-op**：`--latest` 且已是最新 → 零 compose、零备份、**不写 .env.prod**；
// 2. **顺序**：备份 → pull → wait → metadata（索引比较）；备份失败**不得** pull；
// 3. **两段式配置**：升级成功前 `.env.prod` 逐字节不变，成功后一次性提交。

/** 一次升级编排事件（备份 / 同步 / compose / drain 同处一条时间轴，便于索引比较）。 */
export interface UpdateEvent {
  kind: "backup" | "sync" | "run" | "delete" | "drain";
  detail: string;
}

/** 记录事件的升级 runner（compose 调用进 events，便于与备份/同步比较次序）。 */
export function makeUpdateRunner(
  events: UpdateEvent[],
  overrides: (args: string[]) => Partial<CmdResult> | undefined = () =>
    undefined,
): CommandRunner {
  return {
    run(cmd, args) {
      events.push({ kind: "run", detail: cmd + " " + args.join(" ") });
      return Promise.resolve({
        code: 0,
        stdout: "",
        stderr: "",
        ...(overrides(args) ?? {}),
      });
    },
    spawn(): SpawnHandle {
      throw new Error("update 测试不 spawn");
    },
  };
}

/** 事件首次出现的位置（不存在即 -1）。 */
export function indexOfUpdate(
  events: UpdateEvent[],
  kind: UpdateEvent["kind"],
  needle: string,
): number {
  return events.findIndex((e) => e.kind === kind && e.detail.includes(needle));
}

/** 就绪资产集合（与 prod/release.ts 的 UPDATE_RELEASE_ASSETS 同源）。 */
export const UPDATE_ASSETS = [
  "noj-cli-linux-amd64",
  "noj-cli-linux-amd64.sha256",
  "docker-compose.prod.yml",
  "docker-compose.prod.yml.sha256",
  // Release 资产名非点号开头（GitHub 会改写点号名为 default.<name>）。
  "env.prod.example",
  "env.prod.example.sha256",
  "release-set.json",
  "release-set.json.sha256",
];

/** 造一个 Release 列表 fetcher，并记录请求 URL。 */
export function makeReleaseFetcher(
  releases: unknown[],
  calls: string[] = [],
): Fetcher {
  return (url: string) => {
    calls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify(releases), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}

/** 资产就绪的稳定 Release（含全部 UPDATE_ASSETS）。 */
export function readyUpdateRelease(tag: string): Record<string, unknown> {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: UPDATE_ASSETS.map((name) => ({ name })),
  };
}

// ── P1d：update 自动排空（注入 fake drain）───────────────────────────
//
// 自动排空的编排语义：验签后、启动目标栈前 enter+wait；目标栈健康后 exit。
// 全部经注入的 {@link DrainLifecycle}（不起容器）；事件进同一条时间轴以便断言顺序。

/** 造一个把 enter/wait/exit 记进事件时间轴的 fake drain。 */
export function makeDrain(
  events: UpdateEvent[],
  overrides: Partial<Record<"enter" | "wait" | "exit", DrainResult>> = {},
  contexts: DrainContext[] = [],
): DrainLifecycle {
  const record = (
    kind: "enter" | "wait" | "exit",
    context: DrainContext,
  ): Promise<DrainResult> => {
    events.push({ kind: "drain", detail: kind });
    contexts.push(context);
    return Promise.resolve(
      overrides[kind] ?? { ok: true, code: null, error: null },
    );
  };
  return {
    enter: (context) => record("enter", context),
    wait: (context) => record("wait", context),
    exit: (context) => record("exit", context),
  };
}
