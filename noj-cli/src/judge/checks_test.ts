import { assertEquals, assertRejects } from "@std/assert";
import type { CommandRunner } from "../runtime/command.ts";
import {
  checkBaseEnvironment,
  checkConfigValues,
  checkImageArchitecture,
  checkRedis,
  checkSocket,
} from "./checks.ts";
import type { JudgeEnv } from "./env.ts";
import type { JudgeOptions } from "./options.ts";

function fakeRunner(
  handler?: (
    cmd: string,
    args: string[],
  ) => { code: number; stdout: string; stderr: string },
): CommandRunner {
  return {
    run(cmd, args) {
      if (handler) return Promise.resolve(handler(cmd, args));
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn() {
      throw new Error("not used");
    },
  };
}

const missingDir = `/tmp/noj-judge-missing-${Date.now()}-${
  Math.random()
    .toString(36)
    .slice(2)
}`;

const baseOpts: JudgeOptions = {
  command: "check",
  dir: missingDir,
  envFile: `${missingDir}/.env.judge`,
  composeFile: `${missingDir}/docker-compose.judge.yml`,
  repo: "https://github.com/Neuro-OJ/neuro-oj",
  ref: "main",
  version: undefined,
  redisContainer: "noj-judge-redis",
  redisPort: 16379,
  panel: "none",
  nonInteractive: true,
  downloadOnly: false,
  dryRun: false,
  follow: false,
};

function env(values: Record<string, string>): JudgeEnv {
  return { values };
}

const completeValues: Record<string, string> = {
  NOJ_VERSION: "v0.1.0",
  REDIS_URL: "redis://127.0.0.1:6379/0",
  JUDGE_QUEUE: "noj:judge:queue",
  RESULT_QUEUE: "noj:judge:results",
  WORK_DIR: "/tmp/noj-judge",
  JUDGE_MAX_CONCURRENT_JUDGES: "2",
  JUDGE_IMAGE_PREFIX: "noj-",
  JUDGE_IMAGE_REGISTRY: "ghcr.io/neuro-oj",
  JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock",
  JUDGE_DOCKER_SOCKET_GID: "10001",
  JUDGE_UID: "10001",
  JUDGE_GID: "10001",
  JUDGE_DOCKER_HOST: "unix:///run/noj-judge/docker.sock",
  JUDGE_REQUIRE_ISOLATED_DOCKER: "true",
};

Deno.test("checkConfigValues: 完整配置无问题", () => {
  assertEquals(checkConfigValues(env(completeValues)), []);
});

Deno.test("checkConfigValues: 禁止的 socket 与占位值返回问题", () => {
  const issues = checkConfigValues(env({
    NOJ_VERSION: "latest",
    REDIS_URL: "change-me",
    JUDGE_DOCKER_SOCKET: "/var/run/docker.sock",
    JUDGE_DOCKER_SOCKET_GID: "abc",
    JUDGE_UID: "0",
    JUDGE_GID: "0",
    JUDGE_DOCKER_HOST: "unix:///var/run/docker.sock",
    JUDGE_REQUIRE_ISOLATED_DOCKER: "false",
  }));
  assertEquals(issues.length > 0, true);
});

Deno.test("checkConfigValues: 非法版本与数值返回问题", () => {
  const issues = checkConfigValues(env({
    ...completeValues,
    NOJ_VERSION: "main",
    JUDGE_MAX_CONCURRENT_JUDGES: "0",
    JUDGE_DOCKER_SOCKET_GID: "abc",
    JUDGE_DOCKER_HOST: "tcp://127.0.0.1:2375",
    JUDGE_REQUIRE_ISOLATED_DOCKER: "false",
  }));
  assertEquals(issues.length > 0, true);
});

Deno.test("checkConfigValues: WORK_DIR=/srv/main 不算占位值", () => {
  const issues = checkConfigValues(env({
    ...completeValues,
    WORK_DIR: "/srv/main",
  }));
  assertEquals(issues, []);
});

Deno.test("checkConfigValues: JUDGE_QUEUE=xxx-prod 不算占位值", () => {
  const issues = checkConfigValues(env({
    ...completeValues,
    JUDGE_QUEUE: "xxx-prod",
  }));
  assertEquals(issues, []);
});

Deno.test("checkConfigValues: NOJ_VERSION=latest/xxx-prod 是占位/非法", () => {
  for (const version of ["latest", "xxx-prod"]) {
    const issues = checkConfigValues(env({
      ...completeValues,
      NOJ_VERSION: version,
    }));
    assertEquals(issues.some((i) => i.includes("NOJ_VERSION")), true);
  }
});

Deno.test("checkBaseEnvironment: Linux + docker ok 不抛错", async () => {
  await checkBaseEnvironment(baseOpts, fakeRunner());
});

Deno.test("checkBaseEnvironment: docker 缺失抛缺少依赖", async () => {
  const runner = fakeRunner((cmd, args) => {
    if (cmd === "uname" && args[0] === "-s") {
      return { code: 0, stdout: "Linux\n", stderr: "" };
    }
    if (cmd === "uname" && args[0] === "-m") {
      return { code: 0, stdout: "x86_64\n", stderr: "" };
    }
    if (cmd === "docker") throw new Deno.errors.NotFound("docker not found");
    return { code: 0, stdout: "", stderr: "" };
  });
  await assertRejects(
    () => checkBaseEnvironment(baseOpts, runner),
    Error,
    "缺少依赖：docker",
  );
});

Deno.test("checkBaseEnvironment: 非 Linux 抛错", async () => {
  const runner = fakeRunner((cmd, args) => {
    if (cmd === "uname" && args[0] === "-s") {
      return { code: 0, stdout: "Darwin\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  await assertRejects(() => checkBaseEnvironment(baseOpts, runner));
});

Deno.test("checkBaseEnvironment: 不支持的架构抛错", async () => {
  const runner = fakeRunner((cmd, args) => {
    if (cmd === "uname" && args[0] === "-s") {
      return { code: 0, stdout: "Linux\n", stderr: "" };
    }
    if (cmd === "uname" && args[0] === "-m") {
      return { code: 0, stdout: "mips\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  await assertRejects(() => checkBaseEnvironment(baseOpts, runner));
});

Deno.test("checkBaseEnvironment: docker info 失败抛错", async () => {
  const runner = fakeRunner((cmd, args) => {
    if (cmd === "docker" && args[0] === "info") {
      return { code: 1, stdout: "", stderr: "cannot connect" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  await assertRejects(() => checkBaseEnvironment(baseOpts, runner));
});

Deno.test("checkBaseEnvironment: docker compose v2 不可用抛错", async () => {
  const runner = fakeRunner((cmd, args) => {
    if (cmd === "docker" && args[0] === "compose" && args[1] === "version") {
      return { code: 1, stdout: "", stderr: "missing compose" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  await assertRejects(() => checkBaseEnvironment(baseOpts, runner));
});

Deno.test("checkBaseEnvironment: 目标目录存在且磁盘读取正常时不抛错", async () => {
  const dir = Deno.makeTempDirSync();
  const runner = fakeRunner((cmd, args) => {
    if (cmd === "uname" && args[0] === "-s") {
      return { code: 0, stdout: "Linux\n", stderr: "" };
    }
    if (cmd === "uname" && args[0] === "-m") {
      return { code: 0, stdout: "x86_64\n", stderr: "" };
    }
    if (cmd === "df" && args[0] === "-Pk" && args[1] === dir) {
      return {
        code: 0,
        stdout:
          "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 100 90 999999999 0% " +
          dir + "\n",
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  await checkBaseEnvironment({ ...baseOpts, dir }, runner);
});

Deno.test("checkSocket: 专用 socket 可用时无问题", async () => {
  const dir = Deno.makeTempDirSync();
  const socketPath = `${dir}/docker.sock`;
  const listener = Deno.listen({ path: socketPath, transport: "unix" });
  try {
    const stat = Deno.statSync(socketPath);
    const gid = stat.gid?.toString() ?? "";
    const issues = await checkSocket(
      env({
        JUDGE_DOCKER_SOCKET: socketPath,
        JUDGE_DOCKER_SOCKET_GID: gid,
      }),
      fakeRunner(),
    );
    assertEquals(issues, []);
  } finally {
    listener.close();
  }
});

Deno.test("checkSocket: 权限检查使用 runner test，GID 不匹配时不报权限问题", async () => {
  const dir = Deno.makeTempDirSync();
  const socketPath = `${dir}/docker.sock`;
  const listener = Deno.listen({ path: socketPath, transport: "unix" });
  try {
    const stat = Deno.statSync(socketPath);
    const gid = stat.gid?.toString() ?? "";
    const configuredGid = gid === "0" ? "1" : "0";
    const seenTests: string[] = [];
    const runner = fakeRunner((cmd, args) => {
      if (cmd === "test") {
        seenTests.push(args[0] ?? "");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const issues = await checkSocket(
      env({
        JUDGE_DOCKER_SOCKET: socketPath,
        JUDGE_DOCKER_SOCKET_GID: configuredGid,
      }),
      runner,
    );
    assertEquals(seenTests.sort(), ["-r", "-w"]);
    assertEquals(issues.some((i) => i.includes("无法读写")), false);
    assertEquals(issues.some((i) => i.includes("GID")), true);
  } finally {
    listener.close();
  }
});

Deno.test("checkSocket: docker 缺失返回缺少依赖", async () => {
  const dir = Deno.makeTempDirSync();
  const socketPath = `${dir}/docker.sock`;
  const listener = Deno.listen({ path: socketPath, transport: "unix" });
  try {
    const stat = Deno.statSync(socketPath);
    const gid = stat.gid?.toString() ?? "";
    const runner = fakeRunner((cmd) => {
      if (cmd === "test") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "docker") throw new Deno.errors.NotFound("docker not found");
      return { code: 0, stdout: "", stderr: "" };
    });
    const issues = await checkSocket(
      env({
        JUDGE_DOCKER_SOCKET: socketPath,
        JUDGE_DOCKER_SOCKET_GID: gid,
      }),
      runner,
    );
    assertEquals(issues, ["缺少依赖：docker"]);
  } finally {
    listener.close();
  }
});

Deno.test("checkSocket: 禁止使用宿主机 socket", async () => {
  const issues = await checkSocket(
    env({
      JUDGE_DOCKER_SOCKET: "/var/run/docker.sock",
      JUDGE_DOCKER_SOCKET_GID: "0",
    }),
    fakeRunner(),
  );
  assertEquals(issues.length > 0, true);
});

Deno.test("checkSocket: 非 socket 路径返回问题", async () => {
  const dir = Deno.makeTempDirSync();
  const file = `${dir}/not-socket`;
  Deno.writeTextFileSync(file, "x");
  const issues = await checkSocket(
    env({
      JUDGE_DOCKER_SOCKET: file,
      JUDGE_DOCKER_SOCKET_GID: "0",
    }),
    fakeRunner(),
  );
  assertEquals(issues.length > 0, true);
});

Deno.test("checkRedis: redis-cli 可连接时无问题", async () => {
  const issues = await checkRedis(
    env({
      REDIS_URL: "redis://127.0.0.1:6379/0",
    }),
    fakeRunner(),
  );
  assertEquals(issues, []);
});

Deno.test("checkRedis: 无 redis-cli 时使用 docker 客户端成功", async () => {
  const runner = fakeRunner((cmd) => {
    if (cmd === "redis-cli") {
      return { code: 1, stdout: "", stderr: "not found" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const issues = await checkRedis(
    env({
      REDIS_URL: "redis://127.0.0.1:6379/0",
    }),
    runner,
  );
  assertEquals(issues, []);
});

Deno.test("checkRedis: 非法协议返回问题", async () => {
  const issues = await checkRedis(
    env({
      REDIS_URL: "tcp://127.0.0.1:6379",
    }),
    fakeRunner(),
  );
  assertEquals(issues.length > 0, true);
});

Deno.test("checkImageArchitecture: 本地镜像架构匹配无问题", async () => {
  const runner = fakeRunner((cmd, args) => {
    if (cmd === "uname" && args[0] === "-m") {
      return { code: 0, stdout: "x86_64\n", stderr: "" };
    }
    if (cmd === "docker" && args[0] === "image" && args[1] === "inspect") {
      return { code: 0, stdout: "amd64\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const issues = await checkImageArchitecture(
    env({
      NOJ_VERSION: "v0.1.0",
      JUDGE_IMAGE_REGISTRY: "ghcr.io/neuro-oj",
    }),
    runner,
  );
  assertEquals(issues, []);
});

Deno.test("checkImageArchitecture: 本地镜像架构不匹配返回问题", async () => {
  const runner = fakeRunner((cmd, args) => {
    if (cmd === "uname" && args[0] === "-m") {
      return { code: 0, stdout: "x86_64\n", stderr: "" };
    }
    if (cmd === "docker" && args[0] === "image" && args[1] === "inspect") {
      return { code: 0, stdout: "arm64\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const issues = await checkImageArchitecture(
    env({
      NOJ_VERSION: "v0.1.0",
      JUDGE_IMAGE_REGISTRY: "ghcr.io/neuro-oj",
    }),
    runner,
  );
  assertEquals(issues.length > 0, true);
});

Deno.test("checkImageArchitecture: manifest 含当前架构无问题", async () => {
  const runner = fakeRunner((cmd, args) => {
    if (cmd === "uname" && args[0] === "-m") {
      return { code: 0, stdout: "x86_64\n", stderr: "" };
    }
    if (cmd === "docker" && args[0] === "image" && args[1] === "inspect") {
      return { code: 1, stdout: "", stderr: "not found" };
    }
    if (cmd === "docker" && args[0] === "buildx" && args[1] === "imagetools") {
      return { code: 0, stdout: "Platform: linux/amd64\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const issues = await checkImageArchitecture(
    env({
      NOJ_VERSION: "v0.1.0",
      JUDGE_IMAGE_REGISTRY: "ghcr.io/neuro-oj",
    }),
    runner,
  );
  assertEquals(issues, []);
});

Deno.test("checkImageArchitecture: manifest 缺少当前架构返回问题", async () => {
  const runner = fakeRunner((cmd, args) => {
    if (cmd === "uname" && args[0] === "-m") {
      return { code: 0, stdout: "x86_64\n", stderr: "" };
    }
    if (cmd === "docker" && args[0] === "image" && args[1] === "inspect") {
      return { code: 1, stdout: "", stderr: "not found" };
    }
    if (cmd === "docker" && args[0] === "buildx" && args[1] === "imagetools") {
      return { code: 0, stdout: "Platform: linux/arm64\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const issues = await checkImageArchitecture(
    env({
      NOJ_VERSION: "v0.1.0",
      JUDGE_IMAGE_REGISTRY: "ghcr.io/neuro-oj",
    }),
    runner,
  );
  assertEquals(issues.length > 0, true);
});

Deno.test("checkImageArchitecture: 无法读取 manifest 时视为警告不返回问题", async () => {
  const runner = fakeRunner((cmd, args) => {
    if (cmd === "uname" && args[0] === "-m") {
      return { code: 0, stdout: "x86_64\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "not available" };
  });
  const issues = await checkImageArchitecture(
    env({
      NOJ_VERSION: "v0.1.0",
      JUDGE_IMAGE_REGISTRY: "ghcr.io/neuro-oj",
    }),
    runner,
  );
  assertEquals(issues, []);
});

Deno.test("checkImageArchitecture: manifest 不可读时打印警告", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "));
  };
  try {
    const runner = fakeRunner((cmd, args) => {
      if (cmd === "uname" && args[0] === "-m") {
        return { code: 0, stdout: "x86_64\n", stderr: "" };
      }
      if (cmd === "docker" && args[0] === "image" && args[1] === "inspect") {
        return { code: 1, stdout: "", stderr: "not found" };
      }
      if (
        cmd === "docker" && args[0] === "buildx" && args[1] === "imagetools"
      ) {
        return { code: 1, stdout: "", stderr: "not available" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const issues = await checkImageArchitecture(
      env({
        NOJ_VERSION: "v0.1.0",
        JUDGE_IMAGE_REGISTRY: "ghcr.io/neuro-oj",
      }),
      runner,
    );
    assertEquals(issues, []);
    assertEquals(warnings.length > 0, true);
  } finally {
    console.warn = originalWarn;
  }
});
