/**
 * prod/compose 测试：全部注入 fake runner，绝不触真实 docker。
 *
 * 服务集核对**读取仓库内真实的 docker-compose.prod.yml 并按缩进层级解析**
 * （services 段内 2 空格缩进的服务名 + 其 4 空格缩进的 profiles 列表），
 * 不在测试里硬编码第二份服务清单。
 */

import { assertEquals } from "@std/assert";
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
  composeUp,
  PROD_COMPOSE_FILE,
  PROD_ENV_FILE,
  PROD_SERVICES,
} from "./compose.ts";

/** 仓库根部的真实生产编排文件。 */
const COMPOSE_URL = new URL(
  "../../../docker-compose.prod.yml",
  import.meta.url,
);

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

/** 记录 run 调用的 fake runner；退出码与 stdout 可配置。 */
function fakeRunner(
  code = 0,
  stdout = "",
): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      run(cmd, args) {
        calls.push([cmd, ...args]);
        const result: CmdResult = { code, stdout, stderr: "" };
        return Promise.resolve(result);
      },
      spawn(_opts: SpawnOpts): SpawnHandle {
        throw new Error("fake runner 不 spawn");
      },
    },
  };
}

const COMPOSE = "/opt/neuro-oj/docker-compose.prod.yml";
const ENV = "/opt/neuro-oj/.env.prod";

Deno.test("PROD_COMPOSE_FILE/PROD_ENV_FILE: 命名 T9 bootstrap 下载的固定文件", () => {
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

Deno.test("服务集核对: 恰好两组成员带 profile，且 profile 名在真实文件中存在", async () => {
  // 只断言 profile 归属，**不**再硬编码第二份服务名清单（由上一个测试的
  // 逐服务双向比对负责）。这里额外用真实文件确认 profile 名本身确实被声明过。
  const profiled = PROD_SERVICES.filter((s) => s.profile !== undefined);
  assertEquals(profiled, [
    { name: "judge", profile: "judge" },
    { name: "prometheus", profile: "monitoring" },
    { name: "alertmanager", profile: "monitoring" },
  ]);

  const text = await Deno.readTextFile(COMPOSE_URL);
  const parsed = parseComposeServices(text);
  const declared = new Set([...parsed.values()].flat());
  for (const { profile } of profiled) {
    assertEquals(
      declared.has(profile!),
      true,
      `真实 compose 未声明 profile：${profile}`,
    );
  }
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
    await composeUp(runner, { composeFile: COMPOSE, envFile: ENV }),
    0,
  );
  assertEquals(
    await composeDown(runner, { composeFile: COMPOSE, envFile: ENV }),
    0,
  );
  assertEquals(
    await composePs(runner, { composeFile: COMPOSE, envFile: ENV }),
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
    await composeUp(failed.runner, { composeFile: COMPOSE, envFile: ENV }),
    3,
  );
  assertEquals(
    await composeDown(failed.runner, {
      composeFile: COMPOSE,
      envFile: ENV,
    }),
    3,
  );
  assertEquals(
    await composePs(failed.runner, { composeFile: COMPOSE, envFile: ENV }),
    3,
  );
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
  assertEquals(result, 0);
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

Deno.test("composeConfig: 校验编排，参数形状正确", async () => {
  const { runner, calls } = fakeRunner();
  assertEquals(
    await composeConfig(runner, { composeFile: COMPOSE, envFile: ENV }),
    0,
  );
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
});
