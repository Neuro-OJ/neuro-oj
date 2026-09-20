// ── 评审发现（Critical）：共享 socket 守卫可被尾部斜杠绕过 ────────────
//
// `assertDedicatedSocket` 只比较字面量、`collapseSlashes` 与 `realpath`，
// 而 `collapseSlashes` **不处理尾部斜杠**、`realPath("/var/run/docker.sock/")`
// 又因 NotADirectory 返回 ""（被当作"路径不存在，跳过"）。于是这些写法全部放行：
//
//   /var/run/docker.sock/     /run/docker.sock/
//   /var/run/docker.sock/.    /run/docker.sock/./
//
// 实测（真实 Docker）：尾部斜杠的 bind **源**同样会挂载宿主路径——
// 即一个手误的斜杠就能把应用宿主机 socket 交给 Judge，正是本模块存在的意义所在。
// 守卫的价值**全在负空间**（能否拒绝），所以这里用表驱动把变体钉死。

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { UsageError } from "../../util/args.ts";

Deno.test("评审: 共享 socket 守卫必须拒绝尾部斜杠/点段等一切等价写法", async () => {
  const { assertDedicatedSocket } = await import("./config.ts");
  const bypasses = [
    "/var/run/docker.sock/",
    "/run/docker.sock/",
    "/var/run/docker.sock/.",
    "/var/run/docker.sock/./",
    "/run/docker.sock/./",
    "//var/run/docker.sock",
    "//run//docker.sock//",
    "/var/run/docker.sock/..//docker.sock",
    "/run/./docker.sock",
  ];
  for (const p of bypasses) {
    assertThrows(
      () => assertDedicatedSocket(p, () => ""),
      UsageError,
      undefined,
      `必须拒绝等价写法 ${
        JSON.stringify(p)
      }（尾部斜杠/点段不改变它指向宿主 socket 的事实）`,
    );
  }
});

Deno.test("评审: 共享 socket 守卫对 realpath 抛错的输入也不放行", async () => {
  const { assertDedicatedSocket } = await import("./config.ts");
  // 真实 Deno.realPathSync 对 `/var/run/docker.sock/` 抛 NotADirectory；
  // 守卫必须自己归一化，不能依赖 realpath 成功。
  assertThrows(
    () => assertDedicatedSocket("/var/run/docker.sock/"),
    UsageError,
  );
});

Deno.test("评审: 专用 socket 的合法写法仍放行（不误伤）", async () => {
  const { assertDedicatedSocket } = await import("./config.ts");
  for (
    const ok of [
      "/run/noj-judge/docker.sock",
      "/run/noj-judge/docker.sock/",
      "/var/run/noj-judge/docker.sock",
      "/tmp/rootless/docker.sock",
    ]
  ) {
    assertDedicatedSocket(ok, () => "");
  }
});

// ── 用户要求：补本地 Redis 模式（原先函数已导出但零调用者、零测试）──
//
// bash `judge-install.sh` 的 `create_local_redis()`（:391-460）提供
// "为本机 Judge 创建一个仅绑定回环地址的 Redis"：
//   - 只能管理带 `com.neuro-oj.component=judge-standalone-redis` 标签的同名容器，
//     否则**绝不删改**别人的容器；
//   - 端口必须 1024-65535 且**未被占用**；
//   - 生成随机口令、`appendonly yes` 配置（600）、`127.0.0.1:<port>:6379`（仅回环）、
//     独立数据卷；
//   - 产出 core/runtime/check 三个连接串（runtime 走 `host.docker.internal`，
//     因为 Judge 在容器里、Redis 在宿主机）。
//
// TS 侧的 `assertRedisPort`/`assertRedisContainerName`/`generateRedisPassword`
// 与相关常量**早已导出但没有任何非测试调用者**——即"实现有、接线漏"。
// 本组用例覆盖校验层与编排层。

Deno.test("本地 Redis：端口必须在 1024-65535（拒绝特权端口与越界）", async () => {
  const { assertRedisPort } = await import("./config.ts");
  assertRedisPort(16379);
  assertRedisPort(1024);
  assertRedisPort(65535);
  for (const bad of [80, 443, 1023, 65536, 0, -1, 1.5]) {
    assertThrows(
      () => assertRedisPort(bad),
      UsageError,
      undefined,
      `端口 ${bad} 必须被拒绝`,
    );
  }
});

Deno.test("本地 Redis：容器名格式校验（防注入进 docker 参数）", async () => {
  const { assertRedisContainerName } = await import("./config.ts");
  assertRedisContainerName("noj-judge-redis");
  assertRedisContainerName("a");
  assertRedisContainerName("a.b_c-d");
  for (const bad of ["-lead", ".lead", "has space", "a;rm -rf", "$(x)", ""]) {
    assertThrows(
      () => assertRedisContainerName(bad),
      UsageError,
      undefined,
      `容器名 ${JSON.stringify(bad)} 必须被拒绝`,
    );
  }
});

Deno.test("本地 Redis：口令是随机 hex 且长度足够", async () => {
  const { generateRedisPassword } = await import("./config.ts");
  const a = generateRedisPassword();
  const b = generateRedisPassword();
  assertEquals(/^[0-9a-f]{48}$/.test(a), true, `口令应为 48 位 hex，实得 ${a}`);
  assert(a !== b, "两次生成必须不同（真随机）");
});

Deno.test("本地 Redis：已存在同名容器但不是本工具的 → 拒绝，绝不删改", async () => {
  const root = await Deno.makeTempDir();
  try {
    const { createLocalRedis } = await import("./config.ts");
    const calls: string[] = [];
    const runner = {
      run: (cmd: string, args: string[]) => {
        calls.push([cmd, ...args].join(" "));
        // `container inspect` 成功 → 容器已存在
        if (args.includes("inspect")) {
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }
        // 但标签不是我们的
        if (args.includes("--format")) {
          return Promise.resolve({
            code: 0,
            stdout: "someone-elses-redis\n",
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      spawn: () => {
        throw new Error("no spawn");
      },
    };
    await assertRejects(
      () =>
        createLocalRedis({
          dir: root,
          runner,
          containerName: "noj-judge-redis",
          port: 16379,
          nonInteractive: true,
        } as never),
      Error,
      undefined,
      "占用同名容器但不是本工具创建的，必须拒绝",
    );
    // 关键：不得出现任何 `rm`/`stop`/`rmi` 之类破坏性调用
    const destructive = calls.filter((c) => /\brm\b|\brim\b|\bstop\b/.test(c));
    assertEquals(
      destructive,
      [],
      `不得删改他人容器，实得：${destructive.join(" | ")}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("本地 Redis：端口被占用时拒绝（不覆盖既有服务）", async () => {
  const root = await Deno.makeTempDir();
  try {
    const { createLocalRedis } = await import("./config.ts");
    const runner = {
      run: (_cmd: string, args: string[]) => {
        // 容器**不存在**（否则会先撞上"同名容器"分支）
        if (args.includes("inspect")) {
          return Promise.resolve({ code: 1, stdout: "", stderr: "" });
        }
        // `ss -ltnH`：第 4 列是本地地址且以 `:16379` 结尾 → 被占用
        if (args.includes("-ltnH")) {
          return Promise.resolve({
            code: 0,
            stdout: "LISTEN 0 4096 127.0.0.1:16379 0.0.0.0:*\n",
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      spawn: () => {
        throw new Error("no spawn");
      },
    };
    await assertRejects(
      () =>
        createLocalRedis({
          dir: root,
          runner,
          containerName: "noj-judge-redis",
          port: 16379,
          nonInteractive: true,
          probePortInUse: undefined,
        } as never),
      Error,
      "16379",
      "端口被占用必须拒绝",
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("本地 Redis：创建成功时用仅回环绑定 + 标签 + 数据卷 + 600 配置", async () => {
  const root = await Deno.makeTempDir();
  try {
    const { createLocalRedis } = await import("./config.ts");
    const calls: string[] = [];
    const runner = {
      run: (_cmd: string, args: string[]) => {
        calls.push(args.join(" "));
        // 容器不存在；端口未被占用
        if (args.includes("inspect")) {
          return Promise.resolve({ code: 1, stdout: "", stderr: "" });
        }
        if (args.includes("-ltnH")) {
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      spawn: () => {
        throw new Error("no spawn");
      },
    };
    const result = await createLocalRedis({
      dir: root,
      runner,
      containerName: "noj-judge-redis",
      port: 16379,
      nonInteractive: true,
    } as never);

    const joined = calls.join("\n");
    // 仅绑定回环（bash `--publish 127.0.0.1:$port:6379`）
    assert(
      joined.includes("127.0.0.1:16379:6379"),
      `必须仅绑定回环地址，实得：${joined}`,
    );
    // 必须打上本工具的标签（下次才能安全识别"这是我们的容器"）
    assertEquals(result.componentLabel, "judge-standalone-redis");
    assert(joined.includes("com.neuro-oj.component=judge-standalone-redis"));
    // 独立数据卷
    assert(joined.includes("noj-judge-redis-data:/data"), "必须有独立数据卷");
    // 三个连接串：runtime 走 host.docker.internal（Judge 在容器内、Redis 在宿主）
    assert(result.coreUrl.startsWith("redis://:"), result.coreUrl);
    assert(
      result.runtimeUrl.includes("host.docker.internal:16379"),
      `runtime URL 应走 host.docker.internal，实得 ${result.runtimeUrl}`,
    );
    assert(result.checkUrl === result.coreUrl, "check URL 应等于 core URL");
    // 配置文件 600 且含 appendonly（bash heredoc）
    const conf = await Deno.readTextFile(`${root}/redis.conf`);
    assert(conf.includes("appendonly yes"), "配置必须含 appendonly yes");
    assert(conf.includes("requirepass "), "配置必须含 requirepass");
    const st = await Deno.stat(`${root}/redis.conf`);
    assertEquals(st.mode! & 0o777, 0o600, "Redis 配置必须是 600（含口令）");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
