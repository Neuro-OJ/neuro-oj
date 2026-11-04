/**
 * 本地 E2E 会话（P6-B）。
 *
 * 目标：不再依赖固定的容器名、固定主机端口与全局 /tmp/noj-e2e-env.sh。
 * 每个会话拥有：
 * - 唯一 Compose project（noj-e2e-<session>-<random>）与 owner label；
 * - 自动分配、启动后回读并写回清单的主机端口（冲突自动换端口重试）；
 * - 按 run 命名的 evaluator 网络与协调服务 URL；
 * - session 私有清单（默认 noj-tests/test-results/e2e-sessions/<session>.json）
 *   与同目录的 .env 文件；清单是清理、测试入口与审计的唯一事实源；
 * - UI / 题目支持包的构建产物缓存结论（fingerprint + 产物摘要，命中才复用）。
 *
 * 清理只允许触碰清单声明的 project：任何 session 名 / project / owner label
 * 不匹配都拒绝，避免误删开发栈或其他会话。清理失败保留清单，残留资源可审计、
 * 可重试。
 */

import {
  type ArtifactCacheStore,
  type ArtifactSpec,
  type ArtifactState,
  createFileCacheStore,
  describeArtifactState,
  inspectArtifact,
  recordArtifact,
} from "./artifact-cache.ts";

/** session 名：有限长度的小写字母、数字与连字符。 */
export const SESSION_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/;
/** 仓库根：由模块位置推导，保证从任意 cwd（含 noj-tests 内的 deno task）都能工作。 */
export const REPO_ROOT = decodeURIComponent(
  new URL("../..", import.meta.url).pathname,
).replace(/\/+$/, "");

/** 清单默认目录（绝对路径，位于已 gitignore 的 noj-tests/test-results 下）。 */
export const DEFAULT_SESSION_DIR =
  `${REPO_ROOT}/noj-tests/test-results/e2e-sessions`;
/** 构建产物缓存目录（同样位于 gitignore 的 test-results 下）。 */
export const DEFAULT_CACHE_DIR =
  `${REPO_ROOT}/noj-tests/test-results/e2e-cache`;

/** compose 里可回读的主机端口：(服务名, 容器端口, 清单字段)。 */
const PORT_MAPPINGS: ReadonlyArray<{
  service: string;
  container: number;
  key: keyof SessionPorts;
}> = [
  { service: "postgres", container: 5432, key: "postgres" },
  { service: "redis", container: 6379, key: "redis" },
  { service: "noj-core", container: 8000, key: "core" },
  { service: "minio", container: 9000, key: "minio" },
  { service: "minio", container: 9001, key: "minioConsole" },
  { service: "noj-llm-gateway", container: 8001, key: "llmGateway" },
  { service: "llm-mock", container: 8002, key: "llmMock" },
  { service: "test-coordinator", container: 8010, key: "coordinator" },
];

/** 会话主机端口。 */
export interface SessionPorts {
  postgres: number;
  redis: number;
  core: number;
  minio: number;
  minioConsole: number;
  llmGateway: number;
  llmMock: number;
  coordinator: number;
}

/** 会话清单；写入磁盘后是清理与测试入口的唯一事实源。 */
export interface SessionManifest {
  version: 1;
  session: string;
  runId: string;
  composeProject: string;
  ownerLabel: string;
  createdAt: string;
  state: "starting" | "running" | "stopped";
  ports: SessionPorts;
  networkName: string;
  resourcePools: string;
  urls: {
    core: string;
    coordinator: string;
    evaluatorCoordinator: string;
  };
  /** 输入 fingerprint：UI 源码、支持包、SDK 等，变化即失效。 */
  fingerprints: Record<string, string>;
  /** 本次启动复用了哪些构建产物（日志/报告用，不参与清理判定）。 */
  reusedSession?: Record<string, boolean>;
  /** 各产物复用结论（命中的 fingerprint/digest 或失效原因），便于审计。 */
  artifacts?: Record<
    string,
    { fingerprint: string; digest: string; reason: string }
  >;
  /** 最近一次清理失败信息；存在即表示可能有残留资源，清单必须保留。 */
  lastCleanupError?: string;
}

/** 命令执行结果（便于注入 fake）。 */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string[],
  options?: { cwd?: string; env?: Record<string, string> },
) => Promise<CommandResult>;

/** 端口是否可用（注入以便零依赖测试）。 */
export type PortProbe = (port: number) => Promise<boolean>;

export interface SessionDeps {
  run: CommandRunner;
  probePort: PortProbe;
  now?: () => Date;
  randomSuffix?: () => string;
  repoRoot?: string;
}

export interface UpSessionOptions {
  session: string;
  /** 重建容器并清卷，同时强制重建构建产物（不复用缓存）。 */
  fresh?: boolean;
  resourcePools?: string;
  fingerprints?: Record<string, string>;
  sessionDir?: string;
  /** 构建产物缓存目录；默认 noj-tests/test-results/e2e-cache。 */
  cacheDir?: string;
  /** 是否构建 UI；缺省由 NOJ_RUN_BROWSER_E2E=1 触发。 */
  buildUi?: boolean;
  /** 端口冲突时的最大尝试次数（每次都换一整套端口）。 */
  maxPortAttempts?: number;
  /** 可注入的产物规格与缓存（测试用）。 */
  artifactSpecs?: ArtifactSpec[];
  cache?: ArtifactCacheStore;
}

/** 默认命令执行器。 */
export const defaultRun: CommandRunner = async (command, options) => {
  const result = await new Deno.Command(command[0]!, {
    args: command.slice(1),
    cwd: options?.cwd,
    env: { ...Deno.env.toObject(), ...options?.env },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    code: result.code,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
};

/** 通过真实监听判断端口可用；监听后立即释放。 */
export const defaultProbePort: PortProbe = (port) => {
  try {
    const listener = Deno.listen({ hostname: "127.0.0.1", port });
    listener.close();
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
};

/** 校验并返回 session 名；非法直接抛错。 */
export function validateSessionName(name: string): string {
  if (!SESSION_NAME_PATTERN.test(name)) {
    throw new Error(
      `session 名必须为 1-32 位小写字母/数字/连字符且以字母或数字开头结尾：${
        JSON.stringify(name)
      }`,
    );
  }
  return name;
}

/** 清单路径；session 名先校验，避免路径穿越。 */
export function sessionManifestPath(
  session: string,
  sessionDir = DEFAULT_SESSION_DIR,
): string {
  return `${sessionDir.replace(/\/+$/, "")}/${
    validateSessionName(session)
  }.json`;
}

/** Compose project 名（小写、可含数字与连字符）。 */
export function composeProjectFor(runId: string): string {
  return `noj-e2e-${runId}`;
}

/** evaluator 网络名按 run 命名，避免跨会话串网。 */
export function evaluatorNetworkFor(runId: string): string {
  return `noj-e2e-${runId}-evaluator`;
}

export interface BuildManifestOptions {
  session: string;
  runId: string;
  ports: SessionPorts;
  resourcePools?: string;
  fingerprints?: Record<string, string>;
  now?: Date;
}

/** 构造清单；owner label 与 project 名由 runId 派生，清理时逐项核对。 */
export function buildSessionManifest(
  options: BuildManifestOptions,
): SessionManifest {
  const session = validateSessionName(options.session);
  const runId = options.runId;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(runId)) {
    throw new Error(`runId 只允许小写字母/数字/连字符：${runId}`);
  }
  const composeProject = composeProjectFor(runId);
  const networkName = evaluatorNetworkFor(runId);
  return {
    version: 1,
    session,
    runId,
    composeProject,
    ownerLabel: `noj.e2e.session=${session}`,
    createdAt: (options.now ?? new Date()).toISOString(),
    state: "starting",
    ports: options.ports,
    networkName,
    resourcePools: options.resourcePools ?? "ai",
    urls: sessionUrls(options.ports),
    fingerprints: options.fingerprints ?? {},
  };
}

/** 会话对外的 URL 全集；端口回读后需要用实际端口重新计算。 */
export function sessionUrls(ports: SessionPorts): SessionManifest["urls"] {
  return {
    core: `http://localhost:${ports.core}`,
    coordinator: `http://127.0.0.1:${ports.coordinator}`,
    // evaluator 在会话私有网络内按服务名访问协调服务：容器内监听 8010，
    // ports.coordinator 只是宿主机映射；用宿主端口会让评测容器连不上（arrivals=0）。
    evaluatorCoordinator: "http://test-coordinator:8010",
  };
}

/** 校验清单确实属于指定 session/project；清理前必须调用。 */
export function assertSessionOwnership(
  manifest: SessionManifest,
  session: string,
  expectedProject?: string,
): void {
  if (manifest.session !== session) {
    throw new Error(
      `拒绝操作：清单 session=${manifest.session} 与请求 ${session} 不一致`,
    );
  }
  if (manifest.composeProject !== composeProjectFor(manifest.runId)) {
    throw new Error(
      `拒绝操作：清单 project=${manifest.composeProject} 与 runId 派生值不一致`,
    );
  }
  if (manifest.ownerLabel !== `noj.e2e.session=${manifest.session}`) {
    throw new Error("拒绝操作：清单 owner label 与 session 不一致");
  }
  if (expectedProject && manifest.composeProject !== expectedProject) {
    throw new Error(
      `拒绝操作：实际 Compose project ${expectedProject} 与清单 ${manifest.composeProject} 不一致`,
    );
  }
}

/** 已有同名 session 时拒绝覆盖（必须先显式 down）。 */
export function assertSessionAvailable(
  existing: SessionManifest | undefined,
  session: string,
): void {
  if (existing) {
    throw new Error(
      `session ${session} 已存在（project=${existing.composeProject}）；` +
        `请先执行 deno task env:down --session ${session} 再重建`,
    );
  }
}

/** 渲染可 source 的环境文件（session 私有，不写 /tmp 全局文件）。 */
export function renderSessionEnv(manifest: SessionManifest): string {
  const entries: Record<string, string> = {
    NOJ_E2E_SESSION: manifest.session,
    NOJ_E2E_RUN_ID: manifest.runId,
    COMPOSE_PROJECT_NAME: manifest.composeProject,
    E2E_DB_URL: `postgres://e2e:e2e@127.0.0.1:${manifest.ports.postgres}/${
      sessionDatabaseName(manifest)
    }`,
    // 部分 E2E 直接读 DATABASE_URL 做只读核对（如 LLM 治理的受理快照）；
    // 不覆盖会连到 env.e2e.template 里的开发库，断言必然查不到行。
    DATABASE_URL: `postgres://e2e:e2e@127.0.0.1:${manifest.ports.postgres}/${
      sessionDatabaseName(manifest)
    }`,
    // compose 用同名变量创建数据库，避免与 E2E_DB_URL 指向不同库。
    E2E_DATABASE_NAME: sessionDatabaseName(manifest),
    E2E_REDIS_URL: `redis://127.0.0.1:${manifest.ports.redis}/1`,
    // 部分 E2E 用 docker exec 直接向 Redis 发布事件帧；容器名必须指向本会话，
    // 否则会写进默认 8099 开发栈的 Redis，出现"发不出去/收到别人的帧"。
    E2E_REDIS_CONTAINER: `${manifest.composeProject}-redis-1`,
    // 故障注入用例会 docker exec 进 core / minio 删除对象；缺映射会打到默认
    // 8099 开发栈的容器，注入无效导致"应 5xx 实际 200"。
    E2E_CORE_CONTAINER: `${manifest.composeProject}-noj-core-1`,
    E2E_MINIO_CONTAINER: `${manifest.composeProject}-minio-1`,
    E2E_CORE_URL: manifest.urls.core,
    // noj-tests 的 helper 以 E2E_BASE_URL 为唯一入口；不映射会静默回落到默认
    // 8099 的开发栈，让"新会话"跑出旧代码结果。
    E2E_BASE_URL: manifest.urls.core,
    E2E_CORE_PORT: String(manifest.ports.core),
    E2E_PG_PORT: String(manifest.ports.postgres),
    E2E_REDIS_PORT: String(manifest.ports.redis),
    E2E_MINIO_PORT: String(manifest.ports.minio),
    E2E_MINIO_CONSOLE_PORT: String(manifest.ports.minioConsole),
    E2E_LLM_GATEWAY_PORT: String(manifest.ports.llmGateway),
    E2E_LLM_MOCK_PORT: String(manifest.ports.llmMock),
    // LLM 治理用例从 mock 的只读记录入口核对上游实际收到的模型；缺映射会读到
    // 默认 8002 的开发栈 mock，模型计数恒为 0。
    E2E_LLM_MOCK_INSPECT_URL: `http://127.0.0.1:${manifest.ports.llmMock}/`,
    E2E_COORDINATOR_PORT: String(manifest.ports.coordinator),
    // 测试与 compose 使用的规范名（P2 协调服务）；下面两个旧名保留兼容。
    E2E_TEST_COORDINATOR_PORT: String(manifest.ports.coordinator),
    E2E_TEST_COORDINATOR_URL: manifest.urls.coordinator,
    E2E_TEST_COORDINATOR_EVALUATOR_URL: manifest.urls.evaluatorCoordinator,
    E2E_COORDINATOR_URL: manifest.urls.coordinator,
    E2E_EVALUATOR_COORDINATOR_URL: manifest.urls.evaluatorCoordinator,
    E2E_EVALUATOR_NETWORK: manifest.networkName,
    E2E_JUDGE_RESOURCE_POOLS: manifest.resourcePools,
    JWT_SECRET: "e2e-ci-secret-fixed-value-with-32-chars-min-abc",
  };
  return Object.entries(entries)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n") + "\n";
}

/** compose 中的数据库名：由 runId 派生，避免两个会话连到同名库。 */
export function sessionDatabaseName(manifest: SessionManifest): string {
  return manifest.runId.replaceAll("-", "_");
}

/** session 私有 env 文件路径（清单同目录；不含 /tmp 全局文件）。 */
export function sessionEnvPath(
  session: string,
  sessionDir = DEFAULT_SESSION_DIR,
): string {
  return `${sessionDir.replace(/\/+$/, "")}/${
    validateSessionName(session)
  }.env`;
}

/** 把 renderSessionEnv 的输出解析成进程环境对象。 */
export function parseSessionEnv(envText: string): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const line of envText.split("\n")) {
    const match = line.match(/^export ([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    entries.push([match[1]!, JSON.parse(match[2]!) as string]);
  }
  return Object.fromEntries(entries);
}

/** 该会话需要指纹化与缓存的构建产物。 */
export function defaultArtifactSpecs(): ArtifactSpec[] {
  return [
    {
      name: "ui",
      inputs: [
        "noj-ui/app",
        "noj-ui/assets",
        "noj-ui/components",
        "noj-ui/composables",
        "noj-ui/layouts",
        "noj-ui/pages",
        "noj-ui/plugins",
        "noj-ui/server",
        "noj-ui/utils",
        "noj-ui/nuxt.config.ts",
        "noj-ui/package.json",
        "noj-ui/deno.json",
        "noj-ui/deno.lock",
      ],
      artifact: "noj-ui/.output",
      ignore: [/(?:^|\/)(?:node_modules|\.nuxt|\.output|\.git)\//],
    },
    {
      name: "support-packages",
      inputs: [
        "noj-core/data/problems-src",
        "noj-core/scripts/problems-init.ts",
        "noj-core/scripts/noj.ts",
      ],
      artifact: "noj-core/data/packages",
      ignore: [/(?:^|\/)(?:node_modules|\.git)\//],
    },
  ];
}

/** 逐个产物做指纹 + 摘要判定；任何异常都按「需要重建」处理，不放行旧产物。 */
export async function inspectSessionArtifacts(
  repoRoot: string,
  cacheDir: string,
  options: {
    fresh?: boolean;
    cache?: ArtifactCacheStore;
    specs?: ArtifactSpec[];
  } = {},
): Promise<ArtifactState[]> {
  const cache = options.cache ?? createFileCacheStore(cacheDir);
  const specs = options.specs ?? defaultArtifactSpecs();
  const states: ArtifactState[] = [];
  for (const spec of specs) {
    try {
      const state = await inspectArtifact(spec, repoRoot, cache);
      states.push({
        ...state,
        // --fresh 强制重建：命中也不复用，避免拿旧产物验证新代码。
        reusable: options.fresh ? false : state.reusable,
        reason: options.fresh ? "fresh" : state.reason,
      });
    } catch (error) {
      states.push({
        name: spec.name,
        fingerprint: "",
        digest: "",
        present: false,
        reusable: false,
        reason: `inspect-failed: ${
          error instanceof Error ? error.message : error
        }`,
      });
    }
  }
  return states;
}

/** 复用结论转清单字段。 */
export function reusedSessionFrom(
  states: ArtifactState[],
): Record<string, boolean> {
  return Object.fromEntries(
    states.map((state) => [state.name, state.reusable]),
  );
}

/** 复用结论转构建阶段的环境变量（setup.sh 据此跳过或执行构建）。 */
export function artifactEnv(
  states: ArtifactState[],
  options: { buildUi?: boolean } = {},
): Record<string, string> {
  const ui = states.find((state) => state.name === "ui");
  const packages = states.find((state) => state.name === "support-packages");
  return {
    E2E_UI_ARTIFACT_REUSE: ui?.reusable ? "1" : "0",
    E2E_PACKAGES_ARTIFACT_REUSE: packages?.reusable ? "1" : "0",
    E2E_BUILD_UI: options.buildUi === false ? "0" : "1",
  };
}

/** 命中时回写缓存记录，供下一次启动比对。 */
export async function recordSessionArtifacts(
  repoRoot: string,
  cacheDir: string,
  states: ArtifactState[],
  options: { cache?: ArtifactCacheStore; specs?: ArtifactSpec[]; now?: Date } =
    {},
): Promise<ArtifactState[]> {
  const cache = options.cache ?? createFileCacheStore(cacheDir);
  const specs = options.specs ?? defaultArtifactSpecs();
  const updated: ArtifactState[] = [];
  for (const spec of specs) {
    const state = states.find((candidate) => candidate.name === spec.name);
    if (!state) continue;
    if (!state.reusable) {
      // 真正重建过的产物在这里刷新记录；构建失败留下的旧记录会因摘要不符失效。
      const record = await recordArtifact(
        spec,
        repoRoot,
        cache,
        undefined,
        options.now,
      );
      // 只刷新 fingerprint/digest；reusable 与 reason 保留本次启动的**决策**，
      // 否则 --fresh 重建的产物会被误标成「复用」，报告与 clean-run 无法区分。
      updated.push({
        ...state,
        digest: record.digest,
        fingerprint: record.fingerprint,
      });
      continue;
    }
    updated.push(state);
  }
  return updated;
}

/** compose 报错是否为端口冲突（据此换端口重试）。 */
export function isPortConflict(stderr: string): boolean {
  return /port is already allocated|address already in use|Bind for .* failed/i
    .test(
      stderr,
    );
}

/** 回读 compose 实际发布的主机端口；缺失的保留计划值。 */
export async function readActualPorts(
  run: CommandRunner,
  repoRoot: string,
  project: string,
  planned: SessionPorts,
  env: Record<string, string> = {},
): Promise<SessionPorts> {
  const ports: SessionPorts = { ...planned };
  for (const mapping of PORT_MAPPINGS) {
    const result = await run(
      [
        "docker",
        "compose",
        "-p",
        project,
        "-f",
        "docker-compose.e2e.yml",
        "port",
        mapping.service,
        String(mapping.container),
      ],
      { cwd: repoRoot, env },
    );
    if (result.code !== 0) continue;
    const match = result.stdout.trim().match(/:(\d+)\s*$/);
    if (!match) continue;
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0) ports[mapping.key] = port;
  }
  return ports;
}

/** 在候选区间内找一个可用端口；全部占用时抛错，不做静默降级。 */
export async function allocatePort(
  probe: PortProbe,
  options: { start: number; end: number; used: Set<number> },
): Promise<number> {
  for (let port = options.start; port <= options.end; port++) {
    if (options.used.has(port)) continue;
    if (await probe(port)) {
      options.used.add(port);
      return port;
    }
  }
  throw new Error(
    `端口区间 ${options.start}-${options.end} 无可用端口；请先关闭占用会话`,
  );
}

/** 分配整套端口；相邻服务尽量分散，全部记录实际值。 */
export async function allocateSessionPorts(
  probe: PortProbe,
  options: { start?: number; end?: number; used?: Set<number> } = {},
): Promise<SessionPorts> {
  const used = options.used ?? new Set<number>();
  const start = options.start ?? 15400;
  const end = options.end ?? 15999;
  const allocate = () => allocatePort(probe, { start, end, used });
  return {
    postgres: await allocate(),
    redis: await allocate(),
    core: await allocate(),
    minio: await allocate(),
    minioConsole: await allocate(),
    llmGateway: await allocate(),
    llmMock: await allocate(),
    coordinator: await allocate(),
  };
}

async function readManifestFile(
  path: string,
): Promise<SessionManifest | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as SessionManifest;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw new Error(`session 清单损坏：${path}：${String(error)}`);
  }
}

/** 原子写清单（临时文件 + rename），避免半截文件被另一个进程读到。 */
async function writeManifestFile(
  path: string,
  manifest: SessionManifest,
): Promise<void> {
  const separator = path.lastIndexOf("/");
  if (separator > 0) {
    await Deno.mkdir(path.slice(0, separator), { recursive: true });
  }
  const temporary = `${path}.${Deno.pid}.tmp`;
  await Deno.writeTextFile(temporary, JSON.stringify(manifest, null, 2) + "\n");
  await Deno.rename(temporary, path);
}

export function createSessionDeps(
  overrides: Partial<SessionDeps> = {},
): SessionDeps {
  return {
    run: overrides.run ?? defaultRun,
    probePort: overrides.probePort ?? defaultProbePort,
    now: overrides.now,
    randomSuffix: overrides.randomSuffix ??
      (() => crypto.randomUUID().slice(0, 8)),
    // 默认在仓库根执行 compose：cwd 可以是 noj-tests（deno task env:up）。
    repoRoot: overrides.repoRoot ?? REPO_ROOT,
  };
}

/** 读取清单（不存在返回 undefined）。 */
export async function loadSession(
  session: string,
  sessionDir = DEFAULT_SESSION_DIR,
): Promise<SessionManifest | undefined> {
  return await readManifestFile(sessionManifestPath(session, sessionDir));
}

export interface UpResult {
  manifest: SessionManifest;
  manifestPath: string;
  envText: string;
  /** 本次构建产物复用结论（报告与日志用）。 */
  artifactStates: ArtifactState[];
}

/** 清理本会话 project；返回命令结果，由调用方决定是否保留清单。 */
async function cleanupProject(
  run: CommandRunner,
  repoRoot: string,
  project: string,
  env: Record<string, string>,
): Promise<CommandResult> {
  return await run(
    [
      "docker",
      "compose",
      "-p",
      project,
      "-f",
      "docker-compose.e2e.yml",
      "down",
      "-v",
      "--remove-orphans",
    ],
    { cwd: repoRoot, env },
  );
}

/** 删除清单与 env 文件（清理成功后不留审计噪音）。 */
async function removeSessionFiles(
  manifestPath: string,
  envPath: string,
): Promise<void> {
  await Deno.remove(manifestPath).catch(() => {});
  await Deno.remove(envPath).catch(() => {});
}

/** 写 session 私有 env 文件（0600；不含任何全局 /tmp 文件）。 */
async function writeSessionEnvFile(
  path: string,
  text: string,
): Promise<void> {
  const separator = path.lastIndexOf("/");
  if (separator > 0) {
    await Deno.mkdir(path.slice(0, separator), { recursive: true });
  }
  await Deno.writeTextFile(path, text, { mode: 0o600 });
}

function artifactSummary(states: ArtifactState[]) {
  return Object.fromEntries(
    states.map((state) => [
      state.name,
      {
        fingerprint: state.fingerprint,
        digest: state.digest,
        reason: state.reason,
      },
    ]),
  );
}

/**
 * 启动会话。
 *
 * 顺序：分配端口 → 写 starting 清单（中断也能 down）→ 产物复用判定 → setup →
 * 回读实际端口写回 → 记录产物摘要。端口冲突自动换端口重试；失败只清理本会话
 * project，清理失败保留清单以便审计与重试。
 */
export async function upSession(
  options: UpSessionOptions,
  deps: SessionDeps,
): Promise<UpResult> {
  const session = validateSessionName(options.session);
  const sessionDir = options.sessionDir ?? DEFAULT_SESSION_DIR;
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const manifestPath = sessionManifestPath(session, sessionDir);
  const envPath = sessionEnvPath(session, sessionDir);
  assertSessionAvailable(await loadSession(session, sessionDir), session);

  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const runId = `${session}-${
    (deps.randomSuffix ?? (() => crypto.randomUUID().slice(0, 8)))()
  }`;
  const buildUi = options.buildUi ??
    (Deno.env.get("NOJ_RUN_BROWSER_E2E") === "1");
  const attempts = Math.max(1, options.maxPortAttempts ?? 3);
  let ports = await allocateSessionPorts(deps.probePort);
  const states = await inspectSessionArtifacts(repoRoot, cacheDir, {
    fresh: options.fresh,
    cache: options.cache,
    specs: options.artifactSpecs,
  });

  let lastFailure = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const manifest = buildSessionManifest({
      session,
      runId,
      ports,
      resourcePools: options.resourcePools,
      fingerprints: {
        ...(options.fingerprints ?? {}),
        ...Object.fromEntries(
          states.map((state) => [state.name, state.fingerprint]),
        ),
      },
      now: deps.now?.(),
    });
    manifest.reusedSession = reusedSessionFrom(states);
    manifest.artifacts = artifactSummary(states);
    // 先落盘：即使 setup 中途被杀，down 也能找到本会话的 project 并清理。
    await writeManifestFile(manifestPath, manifest);
    const env = {
      ...parseSessionEnv(renderSessionEnv(manifest)),
      ...artifactEnv(states, { buildUi }),
    };

    const setup = await deps.run(
      ["bash", "scripts/e2e/setup.sh", ...(options.fresh ? ["--fresh"] : [])],
      { cwd: repoRoot, env },
    );
    if (setup.code === 0) {
      const actual = await readActualPorts(
        deps.run,
        repoRoot,
        manifest.composeProject,
        ports,
        env,
      );
      const recorded = await recordSessionArtifacts(
        repoRoot,
        cacheDir,
        states,
        {
          cache: options.cache,
          specs: options.artifactSpecs,
          now: deps.now?.(),
        },
      ).catch(() => states);
      manifest.ports = actual;
      manifest.urls = sessionUrls(actual);
      manifest.state = "running";
      // 复用结论取启动时的决策；recorded 只负责把新摘要写进缓存。
      manifest.reusedSession = reusedSessionFrom(states);
      manifest.artifacts = artifactSummary(recorded);
      const envText = renderSessionEnv(manifest);
      await writeManifestFile(manifestPath, manifest);
      await writeSessionEnvFile(envPath, envText);
      return { manifest, manifestPath, envText, artifactStates: recorded };
    }

    lastFailure = `exit ${setup.code}：${setup.stderr.trim()}`;
    const cleanup = await cleanupProject(
      deps.run,
      repoRoot,
      manifest.composeProject,
      env,
    );
    if (cleanup.code !== 0) {
      // 清理失败：保留清单与失败原因，残留资源可审计、可再次 down。
      manifest.state = "starting";
      manifest.lastCleanupError = cleanup.stderr.trim() ||
        `exit ${cleanup.code}`;
      await writeManifestFile(manifestPath, manifest);
      throw new Error(
        `session ${session} 启动失败（${lastFailure}）；清理也失败：${manifest.lastCleanupError}。清单已保留：${manifestPath}`,
      );
    }
    await removeSessionFiles(manifestPath, envPath);
    if (!isPortConflict(setup.stderr) || attempt === attempts) {
      throw new Error(
        `session ${session} 启动失败（${lastFailure}）；已清理本会话资源`,
      );
    }
    // 端口被别的进程抢占：换一整套端口重试，实际端口最终写回清单。
    ports = await allocateSessionPorts(deps.probePort);
  }
  throw new Error(
    `session ${session} 启动失败（端口重试 ${attempts} 次后仍失败）：${lastFailure}`,
  );
}

/** 停止会话：核对 session/project/owner label 后只删除本会话资源。 */
export async function downSession(
  session: string,
  deps: SessionDeps,
  sessionDir = DEFAULT_SESSION_DIR,
): Promise<{ manifest: SessionManifest; envText: string }> {
  const name = validateSessionName(session);
  const manifestPath = sessionManifestPath(name, sessionDir);
  const envPath = sessionEnvPath(name, sessionDir);
  const manifest = await readManifestFile(manifestPath);
  if (!manifest) {
    throw new Error(`session ${name} 不存在：${manifestPath}`);
  }
  // 所有权校验必须在任何删除动作之前：跨 session / 手改清单都要拒绝。
  assertSessionOwnership(manifest, name);
  const env = parseSessionEnv(renderSessionEnv(manifest));
  const result = await cleanupProject(
    deps.run,
    deps.repoRoot ?? REPO_ROOT,
    manifest.composeProject,
    env,
  );
  if (result.code !== 0) {
    // 清理失败时保留清单与失败原因：残留资源仍然可审计，下一次 down 可以重试。
    manifest.lastCleanupError = result.stderr.trim() || `exit ${result.code}`;
    await writeManifestFile(manifestPath, manifest);
    throw new Error(
      `session ${name} 清理失败（exit ${result.code}）：${result.stderr}。清单已保留：${manifestPath}`,
    );
  }
  manifest.state = "stopped";
  delete manifest.lastCleanupError;
  await removeSessionFiles(manifestPath, envPath);
  return { manifest, envText: renderSessionEnv(manifest) };
}

export interface SessionCliDeps extends SessionDeps {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

function parseSessionArgs(args: string[]): {
  command: string;
  session?: string;
  sessionDir?: string;
  fresh: boolean;
  ui: boolean;
} {
  const [command, ...rest] = args;
  let session: string | undefined;
  let sessionDir: string | undefined;
  let fresh = false;
  let ui = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--session") session = rest[++i];
    else if (rest[i] === "--session-dir") sessionDir = rest[++i];
    else if (rest[i] === "--fresh") fresh = true;
    else if (rest[i] === "--ui") ui = true;
    else throw new Error(`未知参数：${rest[i]}`);
  }
  return { command: command ?? "help", session, sessionDir, fresh, ui };
}

/** CLI 入口：up / down / show / env。 */
export async function main(
  args: string[],
  deps: SessionCliDeps = createSessionDeps(),
): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => console.log(text));
  const stderr = deps.stderr ?? ((text: string) => console.error(text));
  try {
    const parsed = parseSessionArgs(args);
    if (parsed.command === "help") {
      stdout(
        "用法：session.ts <up|down|show|env> --session <name> [--fresh] [--ui] [--session-dir <dir>]",
      );
      stdout("  up    启动会话并写清单（--fresh 重建容器/清卷/重建产物）");
      stdout("  down  核对所有权后删除本会话资源");
      stdout("  show  打印清单 JSON");
      stdout("  env   打印可 source 的 session 私有环境变量");
      return 0;
    }
    if (!parsed.session) throw new Error("缺少 --session");
    if (parsed.command === "up") {
      const result = await upSession(
        {
          session: parsed.session,
          sessionDir: parsed.sessionDir,
          fresh: parsed.fresh,
          buildUi: parsed.ui,
          // 资源池可从环境注入（CI 与本地都用同一入口开 native/WASM 池）。
          resourcePools: Deno.env.get("E2E_JUDGE_RESOURCE_POOLS") ?? undefined,
        },
        deps,
      );
      stdout(
        `session ${result.manifest.session} 已启动：project=${result.manifest.composeProject} 清单=${result.manifestPath}`,
      );
      const reused = result.manifest.reusedSession ?? {};
      stdout(
        `reused-session: ui=${reused.ui ? "yes" : "no"} support-packages=${
          reused["support-packages"] ? "yes" : "no"
        }`,
      );
      for (const state of result.artifactStates) {
        stdout("  " + describeArtifactState(state));
      }
      stdout(result.envText);
      return 0;
    }
    if (parsed.command === "down") {
      const result = await downSession(
        parsed.session,
        deps,
        parsed.sessionDir,
      );
      stdout(`session ${result.manifest.session} 已停止并清理`);
      return 0;
    }
    if (parsed.command === "show") {
      const manifest = await loadSession(parsed.session, parsed.sessionDir);
      if (!manifest) throw new Error(`session ${parsed.session} 不存在`);
      stdout(JSON.stringify(manifest, null, 2));
      return 0;
    }
    if (parsed.command === "env") {
      const manifest = await loadSession(parsed.session, parsed.sessionDir);
      if (!manifest) throw new Error(`session ${parsed.session} 不存在`);
      stdout(renderSessionEnv(manifest));
      return 0;
    }
    throw new Error(`未知命令：${parsed.command}`);
  } catch (error) {
    stderr(`[e2e-session] ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
