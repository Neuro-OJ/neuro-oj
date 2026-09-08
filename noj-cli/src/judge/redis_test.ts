import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { CommandRunner } from "../runtime/command.ts";
import type { JudgeOptions } from "./options.ts";
import {
  createLocalRedis,
  generateRedisPassword,
  redisConnectionFiles,
  validateRedisPort,
} from "./redis.ts";

const baseOpts: JudgeOptions = {
  command: "install",
  dir: Deno.makeTempDirSync(),
  envFile: `${Deno.makeTempDirSync()}/.env.judge`,
  composeFile: `${Deno.makeTempDirSync()}/docker-compose.judge.yml`,
  repo: "https://github.com/Neuro-OJ/neuro-oj",
  ref: "main",
  version: "v0.1.0",
  redisContainer: "noj-judge-redis",
  redisPort: 46379,
  panel: "none",
  nonInteractive: true,
  downloadOnly: false,
  dryRun: false,
  follow: false,
};

function fakeRunner(
  handler: (
    cmd: string,
    args: string[],
  ) => { code: number; stdout: string; stderr: string },
): CommandRunner {
  return {
    run(cmd, args) {
      return Promise.resolve(handler(cmd, args));
    },
    spawn() {
      throw new Error("not used");
    },
  };
}

async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = 20000 + Math.floor(Math.random() * 30000);
    try {
      const conn = await Deno.connect({ hostname: "127.0.0.1", port });
      conn.close();
    } catch {
      return port;
    }
  }
  return 46379;
}

Deno.test("generateRedisPassword: 长度大于 32 且为十六进制", () => {
  const password = generateRedisPassword();
  assertEquals(password.length >= 32, true);
  assertEquals(/^[0-9a-f]+$/.test(password), true);
});

Deno.test("validateRedisPort: 合法范围", () => {
  validateRedisPort(1024);
  validateRedisPort(16379);
  validateRedisPort(65535);
  assertThrows(() => validateRedisPort(80));
  assertThrows(() => validateRedisPort(70000));
  assertThrows(() => validateRedisPort(1023));
  assertThrows(() => validateRedisPort(Number.NaN));
});

Deno.test("redisConnectionFiles: 返回元数据与说明文件路径", () => {
  const files = redisConnectionFiles(baseOpts);
  assertEquals(files.metadata, `${baseOpts.dir}/.redis-connection.env`);
  assertEquals(files.guide, `${baseOpts.dir}/redis-connection.txt`);
});

Deno.test("createLocalRedis: 创建容器并写入连接文件（权限 600）", async () => {
  const dir = Deno.makeTempDirSync();
  const port = await freePort();
  const calls: { cmd: string; args: string[] }[] = [];
  const runner = fakeRunner((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "docker" && args[0] === "container" && args[1] === "inspect") {
      return { code: 1, stdout: "", stderr: "No such container" };
    }
    if (cmd === "docker" && args[0] === "run") {
      return { code: 0, stdout: "container-id", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });

  await createLocalRedis({ ...baseOpts, dir, redisPort: port }, runner);

  const metadata = `${dir}/.redis-connection.env`;
  const guide = `${dir}/redis-connection.txt`;
  const metadataText = Deno.readTextFileSync(metadata);
  const guideText = Deno.readTextFileSync(guide);
  assertEquals(metadataText.includes("REDIS_CORE_URL="), true);
  assertEquals(metadataText.includes("REDIS_RUNTIME_URL="), true);
  assertEquals(metadataText.includes("REDIS_CHECK_URL="), true);
  assertEquals(guideText.includes("Redis 连接信息"), true);
  assertEquals(guideText.includes("host.docker.internal"), true);
  assertEquals(Deno.statSync(metadata).mode! & 0o777, 0o600);
  assertEquals(Deno.statSync(guide).mode! & 0o777, 0o600);

  const runCall = calls.find((c) => c.args[0] === "run");
  assertEquals(runCall !== undefined, true);
  assertEquals(runCall!.args.includes("--name"), true);
  assertEquals(runCall!.args.includes("noj-judge-redis"), true);
  assertEquals(runCall!.args.includes("127.0.0.1:" + port + ":6379"), true);
  assertEquals(runCall!.args.at(-1), "/usr/local/etc/redis/redis.conf");
});

Deno.test("createLocalRedis: 复用本工具容器时不重复创建", async () => {
  const dir = Deno.makeTempDirSync();
  const coreUrl = "redis://:old@127.0.0.1:16379/0";
  const runtimeUrl = "redis://:old@host.docker.internal:16379/0";
  const checkUrl = coreUrl;
  const metadata = `${dir}/.redis-connection.env`;
  Deno.writeTextFileSync(
    metadata,
    `REDIS_CORE_URL=${coreUrl}\nREDIS_RUNTIME_URL=${runtimeUrl}\nREDIS_CHECK_URL=${checkUrl}\n`,
  );
  Deno.chmodSync(metadata, 0o600);

  let runCalled = false;
  const runner = fakeRunner((cmd, args) => {
    if (cmd === "docker" && args[0] === "container" && args[1] === "inspect") {
      if (args.includes("--format")) {
        return { code: 0, stdout: "judge-standalone-redis\n", stderr: "" };
      }
      return { code: 0, stdout: "existing-id", stderr: "" };
    }
    if (cmd === "docker" && args[0] === "run") {
      runCalled = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });

  await createLocalRedis({ ...baseOpts, dir, redisPort: 16379 }, runner);

  assertEquals(runCalled, false);
  const text = Deno.readTextFileSync(`${dir}/redis-connection.txt`);
  assertEquals(text.includes(runtimeUrl), true);
});

Deno.test("createLocalRedis: 容器名被其他容器占用时抛错", async () => {
  const dir = Deno.makeTempDirSync();
  const runner = fakeRunner((cmd, args) => {
    if (cmd === "docker" && args[0] === "container" && args[1] === "inspect") {
      if (args.includes("--format")) {
        return { code: 0, stdout: "other\n", stderr: "" };
      }
      return { code: 0, stdout: "other-id", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });

  await assertRejects(
    () => createLocalRedis({ ...baseOpts, dir }, runner),
    Error,
    "容器名已被其他容器占用",
  );
});

Deno.test("createLocalRedis: docker run 失败时抛错", async () => {
  const dir = Deno.makeTempDirSync();
  const port = await freePort();
  const runner = fakeRunner((cmd, args) => {
    if (cmd === "docker" && args[0] === "container" && args[1] === "inspect") {
      return { code: 1, stdout: "", stderr: "No such container" };
    }
    if (cmd === "docker" && args[0] === "run") {
      return { code: 1, stdout: "", stderr: "port busy" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });

  await assertRejects(
    () => createLocalRedis({ ...baseOpts, dir, redisPort: port }, runner),
    Error,
    "本机 Redis 创建失败",
  );
});

Deno.test("createLocalRedis: 端口已被占用时抛错", async () => {
  const dir = Deno.makeTempDirSync();
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  try {
    const runner = fakeRunner((cmd, args) => {
      if (
        cmd === "docker" && args[0] === "container" && args[1] === "inspect"
      ) {
        return { code: 1, stdout: "", stderr: "No such container" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await assertRejects(
      () => createLocalRedis({ ...baseOpts, dir, redisPort: port }, runner),
      Error,
      "端口已被占用",
    );
  } finally {
    listener.close();
  }
});

Deno.test("createLocalRedis: 容器名非法时抛错", async () => {
  const dir = Deno.makeTempDirSync();
  const runner = fakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
  await assertRejects(
    () =>
      createLocalRedis(
        { ...baseOpts, dir, redisContainer: "-bad-name" },
        runner,
      ),
    Error,
    "容器名格式无效",
  );
});
