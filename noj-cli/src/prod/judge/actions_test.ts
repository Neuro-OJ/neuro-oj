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
