// ── T26 补漏：`judge install-env` 与 CLI 可达性 ──────────────────────
//
// **这两个用例来自 T26 验收取证。** 实测编译产物发现：
//
//   $ noj-cli judge status     → exit 2（"未能在当前目录识别出生产安装目录"）
//   $ noj-cli judge install-env → exit 2
//
// 即 T21 交付的 `prod/judge/*`（36 个测试全过）**根本无法从 CLI 到达**：
// `judge` 既不在 `PRODUCTION_COMMANDS`，也没有在 `dispatchProduction` 里分发。
// 更关键的是 `judge install-env` 在 TS 侧**完全没有实现**——而它是 bash
// `judge-install.sh` 的第一个子命令（`install_env()`，:847-867），
// 承担"依赖检查 + rootless 隔离条件指引"，是独立节点部署的入口。
//
// 这是"实现已交付但未接线"的同类问题（与 T24 的接线缺失同源）。

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";

Deno.test("T26: judgeInstallEnv 检查依赖并输出 rootless 隔离指引", async () => {
  const calls: string[] = [];
  const out: string[] = [];
  const { judgeInstallEnv } = await import("./actions.ts");
  const result = await judgeInstallEnv({
    dir: "/srv/noj-judge",
    runner: {
      run(cmd: string, args: string[]) {
        calls.push([cmd, ...args].join(" "));
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      spawn() {
        throw new Error("不应 spawn");
      },
    },
    log: (t: string) => out.push(t),
  });
  assertEquals(result.exitCode, 0);
  // 必须真的探测 daemon 与 compose（而非只打印文案）
  assert(
    calls.some((c) => c.includes("docker") && c.includes("info")),
    `应探测 Docker daemon，实得调用：${calls.join(" | ")}`,
  );
  assert(
    calls.some((c) => c.includes("compose") && c.includes("version")),
    "应探测 Compose v2",
  );
  const text = out.join("\n");
  // 四条隔离条件必须逐条出现（bash :859-864 的等价物）
  for (const kw of ["rootless", "socket", "UID", "Redis"]) {
    assert(text.includes(kw), `指引应含 "${kw}"，实得：${text}`);
  }
  // 安全边界声明不得丢失（bash :865）
  assert(
    text.includes("/var/run/docker.sock"),
    "必须声明不会把宿主 socket 提供给 Judge",
  );
});

Deno.test("T26: judgeInstallEnv 在 daemon 不可用时失败且不打印指引", async () => {
  const out: string[] = [];
  const { judgeInstallEnv } = await import("./actions.ts");
  const result = await judgeInstallEnv({
    dir: "/srv/noj-judge",
    runner: {
      run(_cmd: string, args: string[]) {
        // 只有 `docker info` 失败
        return Promise.resolve({
          code: args[0] === "info" ? 1 : 0,
          stdout: "",
          stderr: "Cannot connect to the Docker daemon",
        });
      },
      spawn() {
        throw new Error("不应 spawn");
      },
    },
    log: (t: string) => out.push(t),
  });
  assertEquals(result.exitCode, 1, "daemon 不可用必须失败");
  assertEquals(
    out.join("\n").includes("rootless"),
    false,
    "前置失败时不得打印后续指引（避免误以为已就绪）",
  );
});

Deno.test("T26 门禁: judge 必须可从 CLI 到达（命令注册表 + 分发）", async () => {
  // 反向门禁：防止"模块已交付但未接线"再次发生。
  // 断言的是**可达性**，而不是某个函数存在。
  const { COMMANDS } = await import("../../commands.ts");
  const names = COMMANDS.map((c) => c.name);
  assert(
    names.includes("judge"),
    `judge 必须在命令注册表中声明（否则用户无法发现），实得：${
      names.join(", ")
    }`,
  );
  const { PRODUCTION_COMMANDS } = await import("../../production.ts");
  assert(
    PRODUCTION_COMMANDS.has("judge"),
    "judge 必须是生产命令（否则不会被分发到生产层）",
  );
});

// ── 评审发现（Critical）：judge upgrade 报成功但版本没变 ──────────────
//
// `renderJudgeCompose` 把版本**烘成字面量**（`image: "…/noj-judge:${version}"`，
// compose.ts:114），不像 `docker-compose.prod.yml` 用 `${NOJ_VERSION}` 插值。
// 因此只改 `NOJ_VERSION` 再 pull/up，拉到的仍是**旧 tag** 的镜像。
//
// bash 的 `upgrade_worker`（judge-install.sh:890）靠 `write_compose`
// （升级前重渲染 compose）避免该问题；TS 版丢掉了这一步。

Deno.test("评审: judge upgrade 必须先重渲染 Compose（否则版本不变的空升级）", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = join(root, "judge");
    await Deno.mkdir(dir, { recursive: true });
    const envFile = join(dir, ".env.judge");
    const composeFile = join(dir, "docker-compose.judge.yml");
    // 既有配置：旧版本 v0.9.5
    // 全部 JUDGE_REQUIRED_KEYS 齐备，才能走到 upgrade 的渲染/pull/up 段；
    // 目标版本直接写 v0.10.0（"用户改完配置再升级"的场景）。
    await Deno.writeTextFile(
      envFile,
      [
        "NOJ_VERSION=v0.10.0",
        "REDIS_URL=redis://redis:6379",
        "JUDGE_QUEUE=noj:judge:queue",
        "RESULT_QUEUE=noj:judge:results",
        "WORK_DIR=/var/lib/noj-judge",
        "JUDGE_MAX_CONCURRENT_JUDGES=2",
        "JUDGE_IMAGE_PREFIX=noj-judge",
        "JUDGE_IMAGE_REGISTRY=ghcr.io/neuro-oj",
        "JUDGE_DOCKER_SOCKET=/run/noj-judge/docker.sock",
        "JUDGE_DOCKER_SOCKET_GID=10001",
        "JUDGE_UID=10001",
        "JUDGE_GID=10001",
        "JUDGE_DOCKER_HOST=unix:///run/noj-judge/docker.sock",
        "JUDGE_REQUIRE_ISOLATED_DOCKER=true",
        "",
      ].join("\n"),
    );
    await Deno.chmod(envFile, 0o600);
    // 既有 compose 仍指向旧版本（模拟未重渲染的状态）
    await Deno.writeTextFile(
      composeFile,
      "services:\n  judge:\n    image: ghcr.io/neuro-oj/noj-judge:v0.9.5\n",
    );

    const { judgeUpgrade } = await import("./actions.ts");
    const res = await judgeUpgrade({
      dir,
      envFile,
      composeFile,
      runner: {
        run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
        spawn: () => {
          throw new Error("no spawn");
        },
      },
      log: () => {},
    });
    void res;

    // 重渲染后 compose 必须指向**新**版本
    const after = await Deno.readTextFile(composeFile);
    assert(
      after.includes("v0.10.0"),
      `upgrade 必须重渲染 compose 到目标版本，实得：${after}`,
    );
    assert(
      !after.includes("v0.9.5"),
      `compose 不得残留旧版本 tag，实得：${after}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
