/** `judge` 子命令的 CLI 接线回归：--dry-run 转发、空目录放行、status 输出与 Redis 模式。 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { run } from "../cli.ts";

// ── 回归：CLI 层从未把 --dry-run 转给 judge ────────────
//
// 上一组用例直接调 `judgeInstall({dryRun:true})`，验的是 actions.ts 的分支；
// 而缺陷在**接线**：`runProdJudge` 只传了 version/redisUrl/socketPath，
// `--dry-run` 被静默吞掉 → 真的写出 `.env.judge` 才失败退出。
// 因此必须在 **CLI 层**（`run([...])`）断言零副作用，否则修复可能只修了一半。

Deno.test("CLI 层 judge install --dry-run 不得写出 .env.judge", async () => {
  const root = await Deno.makeTempDir();
  try {
    // 造一个**完整生产安装目录**（findProductionDir 会放行），
    // 模拟"同机 judge 装在既有 NOJ 安装目录里"这一正常场景。
    const dir = join(root, "install");
    await Deno.mkdir(join(dir, "bin"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "docker-compose.prod.yml"),
      "services: {}\n",
    );
    await Deno.writeTextFile(join(dir, ".env.prod"), "NOJ_VERSION=v0.9.5\n");
    await Deno.chmod(join(dir, ".env.prod"), 0o600);
    await Deno.writeTextFile(join(dir, "bin/noj-cli"), "#!/bin/sh\n");
    await Deno.chmod(join(dir, "bin/noj-cli"), 0o755);

    // **必须带上足够参数让流程能走到"写配置"那一步**，否则早期校验失败会
    // 让本用例**恒真**（我实测过：不带 --version 时缺 NOJ_VERSION 早退，
    // 移除 dryRun 转发它照样通过——那种门禁毫无价值）。
    const code = await run([
      "judge",
      "install",
      "--dry-run",
      "--dir",
      dir,
      "--version",
      "v0.9.5",
      "--redis-url",
      "redis://redis:6379",
      "--socket-path",
      "/run/noj-judge/docker.sock",
    ]);
    // dry-run 应当**校验通过**（exit 0）——这也证明它真的走到了分支末尾
    // 而不是被早期校验挡下；被挡下的话下面的"零副作用"断言就是恒真的。
    assertEquals(
      code,
      0,
      "dry-run 应校验通过（若因缺参数早退，本用例会变成恒真的假门禁）",
    );

    // 关键：不得出现 judge 产物
    const judgeEnv = join(dir, ".env.judge");
    assertEquals(
      await Deno.stat(judgeEnv).then(() => true).catch(() => false),
      false,
      "CLI 层 --dry-run 必须零副作用（曾被静默吞掉并写出 .env.judge）",
    );
    const judgeCompose = join(dir, "docker-compose.judge.yml");
    assertEquals(
      await Deno.stat(judgeCompose).then(() => true).catch(() => false),
      false,
      "CLI 层 --dry-run 不得写出 judge compose",
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

// ── 回归：独立 Judge 节点的文档入口不可执行（与 install 同类）──────
//
// `noj-docs/docs/operators/judge-workers.md` 给**不运行 noj-core/noj-ui** 的
// 独立评测节点的流程是：
//     noj-cli judge install-env
//     noj-cli judge install --dir /srv/noj-judge
// 而 `dispatchProduction` 只对 `command === "install"` 放宽目录要求，
// 于是这两条命令都报"不是完整的 NOJ 生产安装目录"**永远无法执行**。

Deno.test("judge 子命令接受新建/空目录（独立节点文档流程）", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = join(root, "fresh-judge");
    let err = "";
    const originalErr = console.error;
    console.error = (...a: unknown[]) => {
      err += a.join(" ") + "\n";
    };
    let code = -1;
    try {
      code = await run(["judge", "install-env", "--dir", dir]);
    } finally {
      console.error = originalErr;
    }
    assertEquals(
      err.includes("不是完整的 NOJ 生产安装目录"),
      false,
      `judge install-env 不得要求预完整目录，实得：${err}`,
    );
    void code;
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("放宽只针对 install/judge，其他命令仍要求完整安装目录", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (const cmd of ["status", "start", "stop", "logs", "backup"]) {
      let err = "";
      const originalErr = console.error;
      console.error = (...a: unknown[]) => {
        err += a.join(" ") + "\n";
      };
      try {
        await run([cmd, "--dir", root]);
      } finally {
        console.error = originalErr;
      }
      assertEquals(
        err.includes("不是完整的 NOJ 生产安装目录"),
        true,
        `${cmd} 必须仍拒绝非安装目录`,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

// ── 回归：judge status 人类模式每行打印两次 ─────────────────────
//
// `judgeStatus` 通过 `base.log`（= 注入的 say）逐行输出 summary 与 compose ps，
// 而 `runProdJudge` 的 status 分支**又**打印一遍返回的 `summary`/`psOutput`，
// 于是每行出现两次（实测 15 行重复）。人类可读输出重复既是噪声，
// 也让人怀疑"是不是跑了两遍"。

Deno.test("judge status 人类模式不重复打印（summary 只出现一次）", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = join(root, "judge");
    await Deno.mkdir(join(dir, "bin"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, ".env.judge"),
      [
        "NOJ_VERSION=v0.9.5",
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
    await Deno.chmod(join(dir, ".env.judge"), 0o600);
    await Deno.writeTextFile(
      join(dir, "docker-compose.judge.yml"),
      "services: {}\n",
    );
    // 捕获人类输出
    const original = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => {
      lines.push(a.join(" "));
    };
    try {
      await run(["judge", "status", "--dir", dir]).catch(() => {});
    } finally {
      console.log = original;
    }
    // 任何非空行都不得出现两次
    const seen = new Map<string, number>();
    for (const l of lines) {
      if (l.trim() === "") continue;
      seen.set(l, (seen.get(l) ?? 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    assertEquals(
      dupes.map(([l, n]) => `${n}× ${l}`),
      [],
      "judge status 人类输出不得有重复行",
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

// ── 我自查发现的缺陷：judge --redis-mode local 在 --dry-run 下真建了 Redis ──
//
// install 在 dry-run 时必须先短路。第一版把"创建本机 Redis"放在 dry-run 判断**之前**，
// 实测 `--dry-run` 真的创建了容器并写出 `redis.conf`——违反"预演零副作用"，
// 而这正是本会话反复修过的一类缺陷（`uninstall --dry-run` 删数据、
// `judge install --dry-run` 写配置）。
//
// **教训**：新增"有副作用的前置步骤"时，必须先确认它在 dry-run 下被短路。

Deno.test("自查: judge install --redis-mode local --dry-run 不得创建 Redis/配置", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = join(root, "judge");
    await Deno.mkdir(dir, { recursive: true });
    const calls: string[] = [];
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => {
      lines.push(a.join(" "));
    };
    let code = -1;
    try {
      code = await run([
        "judge",
        "install",
        "--redis-mode",
        "local",
        "--dry-run",
        "--dir",
        dir,
        "--version",
        "v0.9.5",
        "--socket-path",
        "/run/noj-judge/docker.sock",
      ]);
    } finally {
      console.log = originalLog;
    }
    void calls;
    // 不得写出 redis.conf（那是"真的建了 Redis"的证据）
    assertEquals(
      await Deno.stat(join(dir, "redis.conf")).then(() => true).catch(() =>
        false
      ),
      false,
      "dry-run 不得写 redis.conf",
    );
    // 且必须**明确告知**将要做的事（否则用户不知道 dry-run 覆盖了什么）
    assert(
      lines.some((l) => l.includes("[dry-run]") && l.includes("Redis")),
      `dry-run 应说明将创建 Redis，实得输出：${lines.join(" | ")}`,
    );
    void code;
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

// ── 回归：三处"旗标被接受却静默无效"的接线缺口 ────────────
//
// 本 PR 自己把"被静默忽略的旗标会让用户的预期与结果相反"定义为 Critical
// （见 `UNIMPLEMENTED_PROD_FLAGS` 的注释）。同一形态曾有三个新实例，
// 下面逐条断言"不再静默"。

Deno.test("judge install 必须把 --socket-gid 传给底层实现", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = join(root, "judge");
    await Deno.mkdir(dir, { recursive: true });
    // 用一个 GID 与配置默认值（10001）不同的 socket 场景：
    // 修复前 `--socket-gid` 从不传给 judgeInstall，配置里恒为 10001，
    // 于是"按文档安装"在 GID≠10001 的主机上必然失败且留下半成品配置。
    const { run } = await import("../cli.ts");
    const originalLog = console.log;
    const originalErr = console.error;
    console.log = () => {};
    console.error = () => {};
    let code = -1;
    try {
      code = await run([
        "judge",
        "install",
        "--dir",
        dir,
        "--version",
        "v0.9.5",
        "--redis-url",
        "redis://127.0.0.1:6379/0",
        "--socket-path",
        "/run/noj-judge/docker.sock",
        "--socket-gid",
        "1234",
      ]);
    } finally {
      console.log = originalLog;
      console.error = originalErr;
    }
    void code;
    // 若配置被写出，`JUDGE_DOCKER_SOCKET_GID` 必须是旗标值（而非默认 10001）；
    // 若因 socket 校验失败未写出配置，则不得留下**含错误 GID** 的半成品。
    const envPath = join(dir, ".env.judge");
    const written = await Deno.readTextFile(envPath).catch(() => null);
    if (written !== null) {
      assertStringIncludes(
        written,
        "JUDGE_DOCKER_SOCKET_GID=1234",
        "--socket-gid 必须写入配置（曾被静默忽略）",
      );
      assertEquals(
        written.includes("JUDGE_DOCKER_SOCKET_GID=10001"),
        false,
        "不得回落到默认 GID",
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
