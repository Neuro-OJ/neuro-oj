/**
 * prod/compose 测试：全部注入 fake runner，绝不触真实 docker。
 *
 * 契约：真实执行时 wrapper 返回**完整** `CmdResult`（`code` + `stdout` + `stderr`），
 * 调用方从 `result.code` 读退出码、从 `result.stdout` 读输出；`dryRun` 时返回参数数组
 * （`Array.isArray(result)` 即 dryRun）。
 *
 * 服务集核对**读取仓库内真实的 docker-compose.prod.yml 并按缩进层级解析**
 * （services 段内 2 空格缩进的服务名 + 其 4 空格缩进的 profiles 列表），
 * 不在测试里硬编码第二份服务清单。
 */

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import type {
  CmdResult,
  CommandRunner,
  SpawnHandle,
  SpawnOpts,
} from "../runtime/command.ts";
import {
  composeArgs,
  composeConfig,
  composeDown,
  composeLogs,
  composePs,
  composePull,
  composeUp,
  PROD_COMPOSE_FILE,
  PROD_ENV_FILE,
  PROD_SERVICES,
} from "./compose.ts";
import type { ComposeResult } from "./compose.ts";

/** 仓库根部的真实生产编排文件。 */
const COMPOSE_URL = new URL(
  "../../../docker-compose.prod.yml",
  import.meta.url,
);
const DEV_COMPOSE_URL = new URL("../../../docker-compose.yml", import.meta.url);

interface ComposeConfigService {
  depends_on?: Record<
    string,
    { condition?: string; required?: boolean } | string
  >;
  command?: unknown;
  entrypoint?: unknown;
  ports?: unknown[];
  restart?: string;
}

interface ComposeConfigDocument {
  services?: Record<string, ComposeConfigService>;
}

/**
 * 通过 Docker Compose 自己的解析器读取配置，而不是只扫描 YAML 文本。
 * 该测试只执行 `config`，不会创建网络、卷或容器。
 */
async function readRealComposeConfig(
  composeUrl: URL,
  env: Record<string, string> = {},
): Promise<ComposeConfigDocument> {
  let envFile: string | undefined;
  try {
    const args = ["compose"];
    if (Object.keys(env).length > 0) {
      envFile = await Deno.makeTempFile({ prefix: "noj-compose-config-" });
      await Deno.writeTextFile(
        envFile,
        Object.entries(env).map(([key, value]) => `${key}=${value}`).join(
          "\n",
        ) +
          "\n",
      );
      args.push("--env-file", envFile);
    }
    args.push(
      "-f",
      fromFileUrl(composeUrl),
      "config",
      "--format",
      "json",
    );
    const result = await new Deno.Command("docker", {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (result.code !== 0) {
      throw new Error(
        `docker compose config 解析失败（exit=${result.code}）`,
      );
    }
    return JSON.parse(
      new TextDecoder().decode(result.stdout),
    ) as ComposeConfigDocument;
  } finally {
    if (envFile !== undefined) await Deno.remove(envFile).catch(() => {});
  }
}

function dependencyCondition(
  service: ComposeConfigService | undefined,
  dependency: string,
): string | undefined {
  const value = service?.depends_on?.[dependency];
  return typeof value === "object" && value !== null
    ? value.condition
    : undefined;
}

const REAL_CONFIG_ENV = {
  NOJ_VERSION: "compose-test",
  POSTGRES_PASSWORD: "compose-test-postgres-password",
  REDIS_PASSWORD: "compose-test-redis-password",
  JWT_SECRET: "compose-test-jwt-secret-012345678901234567890123456789",
  TFA_ENCRYPTION_KEY: "compose-test-tfa-key-012345678901234567890123456789",
  APP_URL: "http://compose-test.invalid",
  CORS_ALLOWED_ORIGINS: "http://compose-test.invalid",
  TRUSTED_PROXIES: "172.28.0.0/16",
  STORAGE_PROVIDER: "s3",
  S3_ACCESS_KEY: "compose-test-storage-user",
  S3_SECRET_KEY: "compose-test-storage-password",
  S3_BUCKET: "compose-test-bucket",
  EMAIL_PROVIDER: "disabled",
  MINIO_ROOT_USER: "compose-test-minio-root",
  MINIO_ROOT_PASSWORD: "compose-test-minio-password",
  NOJ_LLM_SERVICE_TOKEN: "compose-test-llm-service-token",
  NOJ_LLM_STORE_KEY: "compose-test-llm-store-key",
};

/**
 * 缩进感知地解析 compose 的顶层 `services:` 段。
 *
 * 只认零缩进的 `services:` 开段行、2 空格缩进的服务名行（`^  <name>:`），
 * 以及该服务体内 4 空格缩进的 `profiles:` 键下、以 `-` 开头的列表项。
 * 遇到下一个零缩进顶层键（如 `networks:`/`volumes:`）即停止。
 *
 * 返回服务名 -> 所属 profile 列表（无 profile 者为空数组）。
 */
function parseComposeServices(text: string): Map<string, string[]> {
  const services = new Map<string, string[]>();
  const lines = text.split(/\r?\n/);
  let inServices = false;
  let current: { name: string; profiles: string[] } | null = null;
  let inProfiles = false;

  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    // 顶层新键（networks/volumes）→ services 段结束。
    if (/^\S/.test(line)) break;

    const serviceMatch = /^ {2}([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (serviceMatch !== null) {
      if (current !== null) services.set(current.name, current.profiles);
      current = { name: serviceMatch[1]!, profiles: [] };
      inProfiles = false;
      continue;
    }
    if (current === null) continue;

    // 服务体内 4 空格缩进的“仅键”行（如 `profiles:`/`volumes:`）。
    const keyMatch = /^ {4}([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (keyMatch !== null) {
      inProfiles = keyMatch[1] === "profiles";
      continue;
    }
    if (inProfiles) {
      const item = /^\s+-\s+(\S+)\s*$/.exec(line);
      if (item !== null) current.profiles.push(item[1]!);
    }
  }
  if (current !== null) services.set(current.name, current.profiles);
  return services;
}

/** 记录 run 调用的 fake runner；退出码、stdout 与 stderr 可配置。 */
function fakeRunner(
  code = 0,
  stdout = "",
  stderr = "",
): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      run(cmd, args) {
        calls.push([cmd, ...args]);
        const result: CmdResult = { code, stdout, stderr };
        return Promise.resolve(result);
      },
      spawn(_opts: SpawnOpts): SpawnHandle {
        throw new Error("fake runner 不 spawn");
      },
    },
  };
}

/** 从 wrapper 结果中取退出码；dryRun 返回的是参数数组，没有退出码。 */
function exitCode(result: ComposeResult): number {
  if (Array.isArray(result)) throw new Error("dryRun 结果没有退出码");
  return result.code;
}

const COMPOSE = "/opt/neuro-oj/docker-compose.prod.yml";
const ENV = "/opt/neuro-oj/.env.prod";

Deno.test("PROD_COMPOSE_FILE/PROD_ENV_FILE: 命名生产编排与用户维护的配置文件", () => {
  assertEquals(PROD_COMPOSE_FILE, "docker-compose.prod.yml");
  assertEquals(PROD_ENV_FILE, ".env.prod");
});

Deno.test("服务集核对: 解析真实 compose 的 services 段并逐服务比对 profile", async () => {
  const text = await Deno.readTextFile(COMPOSE_URL);
  const parsed = parseComposeServices(text);

  // 解析必须真的生效（若解析器退化，这里会先炸，而不是静默放过）。
  assertEquals(
    parsed.size > 0,
    true,
    "未能从 docker-compose.prod.yml 解析出任何服务",
  );

  // 双向集合相等：既不缺、也不多。
  assertEquals(
    [...parsed.keys()].sort(),
    PROD_SERVICES.map((s) => s.name).sort(),
  );

  // 每个服务的 profile 归属必须逐一对得上。
  for (const { name, profile } of PROD_SERVICES) {
    const actual = parsed.get(name);
    assertEquals(actual !== undefined, true, `compose 缺少服务：${name}`);
    assertEquals(
      [...actual!].sort(),
      profile === undefined ? [] : [profile],
      `服务 ${name} 的 profile 归属不一致`,
    );
  }
});

Deno.test("服务集核对: 带 profile 的服务仅来自真实文件解析结果", async () => {
  // 期望值全部从**真实文件解析结果**派生，不再复制 PROD_SERVICES 自身作为断言基准
  // （那是自指的，模块清单写错时同样"通过"）。逐服务双向比对已由上一个测试负责，
  // 这里只确认「带 profile 的服务确实存在且仅限 judge/monitoring 两组」。
  const text = await Deno.readTextFile(COMPOSE_URL);
  const parsed = parseComposeServices(text);
  const parsedProfiled = [...parsed.entries()]
    .filter(([, profiles]) => profiles.length > 0)
    .map(([name, profiles]) => `${name}:${profiles.sort().join(",")}`)
    .sort();
  assertEquals(parsedProfiled, [
    "alertmanager:monitoring",
    "judge:judge",
    "prometheus:monitoring",
  ]);

  // 解析出的 profile 名只允许属于 ProdProfile 的封闭集合。
  const allowed = new Set(["judge", "monitoring"]);
  for (const profiles of parsed.values()) {
    for (const profile of profiles) {
      assertEquals(
        allowed.has(profile),
        true,
        `真实 compose 出现未知 profile：${profile}`,
      );
    }
  }
});

Deno.test("Gateway 编排: 迁移种子服务先于 HTTP 服务且为完成依赖", async () => {
  const text = await Deno.readTextFile(COMPOSE_URL);
  const migrationStart = text.indexOf("\n  gateway-migrate:");
  const gatewayStart = text.indexOf("\n  llm-gateway:");
  assert(migrationStart >= 0, "生产 compose 缺少 gateway-migrate 服务");
  assert(
    gatewayStart > migrationStart,
    "Gateway HTTP 服务必须排在迁移服务之后",
  );

  const gatewayEnd = text.indexOf("\n  nginx:", gatewayStart + 4);
  assert(gatewayEnd > gatewayStart, "无法解析 llm-gateway 服务段");
  const gatewayBlock = text.slice(gatewayStart, gatewayEnd);
  assert(
    gatewayBlock.includes("gateway-migrate:") &&
      gatewayBlock.includes("condition: service_completed_successfully"),
    "llm-gateway 必须等待 gateway-migrate 成功完成",
  );

  const gatewayMigrationEnd = text.indexOf("\n  core:", migrationStart);
  assert(
    gatewayMigrationEnd > migrationStart,
    "无法解析 gateway-migrate 服务段",
  );
  const gatewayMigrationBlock = text.slice(migrationStart, gatewayMigrationEnd);
  assert(
    gatewayMigrationBlock.includes("migrate:") &&
      gatewayMigrationBlock.includes(
        "condition: service_completed_successfully",
      ),
    "gateway-migrate 必须等待 Core migrate 成功完成，避免并发修改共享 LLM 表",
  );
});

Deno.test("真实 Compose 解析: Core/Gateway one-shot 依赖与 HTTP 启动边界", async () => {
  const document = await readRealComposeConfig(COMPOSE_URL, REAL_CONFIG_ENV);
  const services = document.services ?? {};
  const migrate = services["migrate"];
  const gatewayMigrate = services["gateway-migrate"];
  const core = services["core"];
  const gateway = services["llm-gateway"];

  assert(migrate !== undefined, "生产 compose 必须有 Core migrate service");
  assert(
    gatewayMigrate !== undefined,
    "生产 compose 必须有 Gateway migrate service",
  );
  assert(core !== undefined, "生产 compose 必须有 Core HTTP service");
  assert(gateway !== undefined, "生产 compose 必须有 Gateway HTTP service");

  assertEquals(
    dependencyCondition(gatewayMigrate, "migrate"),
    "service_completed_successfully",
    "Gateway DDL 必须在 Core migrate/init 成功后执行",
  );
  assertEquals(
    dependencyCondition(core, "migrate"),
    "service_completed_successfully",
    "Core HTTP 必须等待 Core migrate/init",
  );
  assertEquals(
    dependencyCondition(core, "gateway-migrate"),
    "service_completed_successfully",
    "Core HTTP 必须等待 Gateway migrate/seed，避免业务 HTTP 与共享表 DDL 并行",
  );
  assertEquals(
    dependencyCondition(gateway, "gateway-migrate"),
    "service_completed_successfully",
    "Gateway HTTP 必须等待 Gateway migrate/seed",
  );
  assertEquals(migrate.restart, "no", "Core migrate 必须是一次性 service");
  assertEquals(
    gatewayMigrate.restart,
    "no",
    "Gateway migrate 必须是一次性 service",
  );
  assert(
    /db migrate/.test(JSON.stringify(migrate.command ?? migrate.entrypoint)) &&
      /init system/.test(JSON.stringify(migrate.command ?? migrate.entrypoint)),
    "Core one-shot 必须显式执行迁移与系统初始化",
  );
  assert(
    /migrate-cli\.ts/.test(
      JSON.stringify(gatewayMigrate.command ?? gatewayMigrate.entrypoint),
    ),
    "Gateway one-shot 必须显式执行 migrate-cli",
  );

  const coreCommand = JSON.stringify(core.command ?? core.entrypoint ?? "");
  const gatewayCommand = JSON.stringify(
    gateway.command ?? gateway.entrypoint ?? "",
  );
  assert(
    !/migrate|init system/i.test(coreCommand),
    "Core HTTP service 不得在启动命令中隐式执行 DDL/init",
  );
  assert(
    !/migrate|seed/i.test(gatewayCommand),
    "Gateway HTTP service 不得在启动命令中隐式执行 DDL/seed",
  );

  // 真实 Compose 归一化后的端口映射是审计边界：业务服务只能 expose 到
  // noj-net，宿主机唯一公开入口是 nginx。
  assertEquals(core.ports ?? [], [], "Core 不得映射宿主机端口");
  assertEquals(gateway.ports ?? [], [], "Gateway 不得映射宿主机端口");
  assert(
    (services["nginx"]?.ports?.length ?? 0) > 0,
    "nginx 应是实际的宿主机 HTTP 入口",
  );
});

Deno.test("真实 Compose 解析: 开发 Gateway 也由完成态 one-shot 门控", async () => {
  const document = await readRealComposeConfig(DEV_COMPOSE_URL);
  const services = document.services ?? {};
  const coreMigrate = services["migrate"];
  const migration = services["llm-gateway-migrate"];
  const gateway = services["llm-gateway"];
  assert(coreMigrate !== undefined, "开发 compose 必须有 Core migrate service");
  assert(
    migration !== undefined,
    "开发 compose 必须有 Gateway migrate service",
  );
  assert(gateway !== undefined, "开发 compose 必须有 Gateway HTTP service");
  assertEquals(coreMigrate.restart, "no");
  assertEquals(migration.restart, "no");
  assert(
    /db migrate/.test(
      JSON.stringify(coreMigrate.command ?? coreMigrate.entrypoint),
    ) && /init system/.test(
      JSON.stringify(coreMigrate.command ?? coreMigrate.entrypoint),
    ),
    "开发 Core one-shot 必须显式执行迁移与系统初始化",
  );
  assertEquals(
    dependencyCondition(migration, "migrate"),
    "service_completed_successfully",
    "开发 Gateway DDL 必须在 Core migrate/init 完成后执行",
  );
  assertEquals(
    dependencyCondition(gateway, "llm-gateway-migrate"),
    "service_completed_successfully",
  );
  assertEquals(gateway.ports ?? [], [{
    mode: "ingress",
    protocol: "tcp",
    published: "8001",
    target: 8001,
  }]);
  assert(
    JSON.stringify(gateway.command ?? gateway.entrypoint ?? "")
      .match(/migrate|seed/i) === null,
    "开发 Gateway HTTP service 不得隐式执行迁移/seed",
  );
  assertEquals(
    services["core"],
    undefined,
    "开发 compose 只提供 Core one-shot，不得额外启动 Core HTTP",
  );
});

Deno.test("Gateway 镜像资产: 显式迁移入口与 journal/SQL 一起打包", async () => {
  const dockerfile = await Deno.readTextFile(
    fromFileUrl(
      new URL("../../../noj-llm-gateway/Dockerfile", import.meta.url),
    ),
  );
  assert(
    dockerfile.includes("COPY drizzle/ ./drizzle/"),
    "Gateway Dockerfile 必须把 drizzle 发布集复制进镜像",
  );
  assert(
    dockerfile.includes("test -f drizzle/meta/_journal.json") &&
      dockerfile.includes("test -f src/db/migrate-cli.ts"),
    "构建阶段必须拒绝缺少迁移入口或 journal 的镜像",
  );
  assert(
    dockerfile.includes(
      "deno cache --lock=deno.lock src/main.ts src/db/migrate-cli.ts",
    ),
    "构建阶段必须预热 HTTP 与显式迁移 CLI 的依赖",
  );
});

Deno.test("composeArgs: 基础形状为数组，且把 --env-file/-f 排在子命令之前", () => {
  const args = composeArgs({
    composeFile: COMPOSE,
    envFile: ENV,
    command: ["ps"],
  });
  assertEquals(args, ["compose", "--env-file", ENV, "-f", COMPOSE, "ps"]);
  // 以数组构造，绝无拼接出的 shell 字符串。
  assertEquals(Array.isArray(args), true);
  assertEquals(args.every((arg) => !arg.includes(" ")), true);
});

Deno.test("composeArgs: judge profile 仅在启用时插入", () => {
  const base = { composeFile: COMPOSE, envFile: ENV, command: ["up", "-d"] };
  assertEquals(composeArgs(base), [
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "up",
    "-d",
  ]);
  assertEquals(composeArgs({ ...base, judge: false }), [
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "up",
    "-d",
  ]);
  assertEquals(composeArgs({ ...base, judge: true }), [
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "--profile",
    "judge",
    "up",
    "-d",
  ]);
});

Deno.test("composeArgs: monitoring profile 按开关插入，且 judge 在前", () => {
  const base = { composeFile: COMPOSE, envFile: ENV, command: ["up", "-d"] };
  assertEquals(composeArgs(base), [
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "up",
    "-d",
  ]);
  assertEquals(composeArgs({ ...base, monitoring: false }), [
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "up",
    "-d",
  ]);
  assertEquals(composeArgs({ ...base, monitoring: true }), [
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "--profile",
    "monitoring",
    "up",
    "-d",
  ]);
  assertEquals(
    composeArgs({ ...base, judge: true, monitoring: true }),
    [
      "compose",
      "--env-file",
      ENV,
      "-f",
      COMPOSE,
      "--profile",
      "judge",
      "--profile",
      "monitoring",
      "up",
      "-d",
    ],
  );
});

Deno.test("composeUp/composeDown/composePs: 参数形状与退出码透传", async () => {
  const { runner, calls } = fakeRunner();
  assertEquals(
    exitCode(await composeUp(runner, { composeFile: COMPOSE, envFile: ENV })),
    0,
  );
  assertEquals(
    exitCode(await composeDown(runner, { composeFile: COMPOSE, envFile: ENV })),
    0,
  );
  assertEquals(
    exitCode(await composePs(runner, { composeFile: COMPOSE, envFile: ENV })),
    0,
  );
  assertEquals(calls, [
    [
      "docker",
      "compose",
      "--env-file",
      ENV,
      "-f",
      COMPOSE,
      "up",
      "-d",
      "--wait",
    ],
    ["docker", "compose", "--env-file", ENV, "-f", COMPOSE, "down"],
    ["docker", "compose", "--env-file", ENV, "-f", COMPOSE, "ps"],
  ]);

  // 非零退出码原样透传，不被吞掉或改写。
  const failed = fakeRunner(3);
  assertEquals(
    exitCode(
      await composeUp(failed.runner, { composeFile: COMPOSE, envFile: ENV }),
    ),
    3,
  );
  assertEquals(
    exitCode(
      await composeDown(failed.runner, { composeFile: COMPOSE, envFile: ENV }),
    ),
    3,
  );
  assertEquals(
    exitCode(
      await composePs(failed.runner, { composeFile: COMPOSE, envFile: ENV }),
    ),
    3,
  );
});

Deno.test("composePs: stdout 原样保留（状态解析的数据源）", async () => {
  const stdout = "NAME  IMAGE  STATUS\ncore  noj-server:1.2.3  running\n";
  const { runner } = fakeRunner(0, stdout);
  const result = await composePs(runner, {
    composeFile: COMPOSE,
    envFile: ENV,
  });
  // 旧实现只返回 result.code，这里会直接失败（number 上没有 stdout）。
  if (Array.isArray(result)) throw new Error("dryRun 不应被触发");
  assertEquals(result.code, 0);
  assertEquals(result.stdout, stdout);
  assertEquals(result.stderr, "");
});

Deno.test("composeUp: 带 services / judge profile 时的参数形状", async () => {
  const { runner, calls } = fakeRunner();
  await composeUp(runner, {
    composeFile: COMPOSE,
    envFile: ENV,
    judge: true,
    services: ["postgres", "redis"],
  });
  assertEquals(calls, [[
    "docker",
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "--profile",
    "judge",
    "up",
    "-d",
    "--wait",
    "postgres",
    "redis",
  ]]);
});

Deno.test("composeLogs: --tail 默认 200，follow 与 services 可叠加", async () => {
  const { runner, calls } = fakeRunner(0, "line-1\n");
  const result = await composeLogs(runner, {
    composeFile: COMPOSE,
    envFile: ENV,
    follow: true,
    services: ["core"],
  });
  // 日志必须留在 stdout 里；旧实现把结果塌缩成 number，这里会直接失败。
  if (Array.isArray(result)) throw new Error("dryRun 不应被触发");
  assertEquals(result.code, 0);
  assertEquals(result.stdout, "line-1\n");
  assertEquals(result.stderr, "");
  assertEquals(calls, [[
    "docker",
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "logs",
    "--tail=200",
    "--follow",
    "core",
  ]]);

  const noFollow = fakeRunner();
  await composeLogs(noFollow.runner, {
    composeFile: COMPOSE,
    envFile: ENV,
  });
  assertEquals(noFollow.calls, [[
    "docker",
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "logs",
    "--tail=200",
  ]]);
});

Deno.test("composeConfig: 校验编排，参数形状正确且 stdout 保留", async () => {
  const { runner, calls } = fakeRunner(0, "services:\n  core: {}\n");
  const result = await composeConfig(runner, {
    composeFile: COMPOSE,
    envFile: ENV,
  });
  if (Array.isArray(result)) throw new Error("dryRun 不应被触发");
  assertEquals(result.code, 0);
  assertEquals(result.stdout, "services:\n  core: {}\n");
  assertEquals(calls, [[
    "docker",
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "config",
  ]]);
});

Deno.test("composeConfig: quiet=true 追加 --quiet（对照 deploy.sh:904 的前置校验）", async () => {
  const { runner, calls } = fakeRunner(0, "");
  const result = await composeConfig(runner, {
    composeFile: COMPOSE,
    envFile: ENV,
    judge: true,
    quiet: true,
  });
  if (Array.isArray(result)) throw new Error("dryRun 不应被触发");
  assertEquals(calls, [[
    "docker",
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "--profile",
    "judge",
    "config",
    "--quiet",
  ]]);
  // --quiet 下 compose 不输出渲染结果
  assertEquals(result.stdout, "");
});

Deno.test("composePull: 拉取镜像，参数形状与位置参数正确", async () => {
  const { runner, calls } = fakeRunner(0, "");
  const result = await composePull(runner, {
    composeFile: COMPOSE,
    envFile: ENV,
    judge: true,
    services: ["core"],
  });
  if (Array.isArray(result)) throw new Error("dryRun 不应被触发");
  assertEquals(calls, [[
    "docker",
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "--profile",
    "judge",
    "pull",
    "core",
  ]]);

  // dryRun：零 runner 调用
  const dry = await composePull(runner, {
    composeFile: COMPOSE,
    envFile: ENV,
    dryRun: true,
  });
  assertEquals(dry, ["compose", "--env-file", ENV, "-f", COMPOSE, "pull"]);
  assertEquals(calls.length, 1);
});

Deno.test("dryRun: 不执行 runner，只返回将执行的参数数组", async () => {
  const { runner, calls } = fakeRunner();

  const upArgs = await composeUp(runner, {
    composeFile: COMPOSE,
    envFile: ENV,
    judge: true,
    dryRun: true,
  });
  assertEquals(upArgs, [
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "--profile",
    "judge",
    "up",
    "-d",
    "--wait",
  ]);
  assertEquals(calls, []);

  const logsArgs = await composeLogs(runner, {
    composeFile: COMPOSE,
    envFile: ENV,
    monitoring: true,
    follow: true,
    services: ["core"],
    dryRun: true,
  });
  assertEquals(logsArgs, [
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "--profile",
    "monitoring",
    "logs",
    "--tail=200",
    "--follow",
    "core",
  ]);
  assertEquals(calls, []);

  const configArgs = await composeConfig(runner, {
    composeFile: COMPOSE,
    envFile: ENV,
    dryRun: true,
  });
  assertEquals(configArgs, [
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "config",
  ]);
  assertEquals(calls, []);

  const downArgs = await composeDown(runner, {
    composeFile: COMPOSE,
    envFile: ENV,
    services: ["redis"],
    dryRun: true,
  });
  assertEquals(downArgs, [
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "down",
    "redis",
  ]);
  assertEquals(calls, []);

  const psArgs = await composePs(runner, {
    composeFile: COMPOSE,
    envFile: ENV,
    dryRun: true,
  });
  assertEquals(psArgs, [
    "compose",
    "--env-file",
    ENV,
    "-f",
    COMPOSE,
    "ps",
  ]);
  assertEquals(calls, []);

  // dryRun 返回值是数组（与真实执行的 CmdResult 可区分）。
  assertEquals(Array.isArray(upArgs), true);
  assertEquals(Array.isArray(logsArgs), true);
  assertEquals(Array.isArray(configArgs), true);
  assertEquals(Array.isArray(downArgs), true);
  assertEquals(Array.isArray(psArgs), true);
});
