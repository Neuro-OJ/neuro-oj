/**
 * 生产生命周期测试：update 自动排空、验签先于启动等升级序列回归。
 *
 * 全部注入 runner / fetcher / IO，永不触碰真实 docker 与网络。
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import type { CommandRunner, SpawnHandle } from "../runtime/command.ts";
import type { RenderIO } from "../output/render.ts";
import { install, update } from "./lifecycle.ts";
import {
  assertRemovableInstallDir,
  WAIT_FAILURE_HINT,
} from "./lifecycle/steps.ts";
import { configuredVersion } from "./release.ts";
import type { DrainContext, DrainResult } from "./lifecycle/drain.ts";
import {
  captureRenderIO,
  COMPOSE,
  ENV_FILE,
  indexOfUpdate,
  makeDrain,
  makeFetcher,
  makeInstalledDir,
  makeIO,
  makeReleaseFetcher,
  makeRunner,
  makeUpdateRunner,
  NO_COLOR,
  readyUpdateRelease,
  REF,
  REPO,
  RunnerCall,
  SOCKET_PRESENT,
  UpdateEvent,
  writePassphraseFile,
} from "./lifecycle_fixtures.ts";

/** update 的公共注入（与既有 update 用例同源）。 */
function updateBase(
  dir: string,
  events: UpdateEvent[],
  io: RenderIO,
) {
  return {
    dir,
    runner: makeUpdateRunner(events),
    io,
    color: NO_COLOR,
    socketExists: SOCKET_PRESENT,
    processEnv: {
      NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
    },
    warn: () => {},
    syncFiles: () => Promise.resolve(),
    backup: () =>
      Promise.resolve({ ok: true, path: "/tmp/x.nojbackup", error: null }),
  };
}

// ── P1a（2026-10-20 架构整治）：先解析目标发布集、pull、验签，再启动 ──────────
//
// 旧实现的三处缺陷（本组用例钉住修复后的不变量）：
// 1. 顺序：backup → pull → waitForStack（启动）→ verifyImageSignatures（验签在启动后）；
// 2. 对象：验签读 prepareAndCheck 返回的旧 `.env.prod`，pull/up 读暂存 staged env；
// 3. 失败语义：验签失败时目标栈已被启动（且 `--latest` 的暂存配置已提交）。
//
// 修复后 `ResolvedTargetConfig` 是唯一事实源，序列为
// 解析目标配置 → 备份 → pull → 验签 → waitForStack → metadata → 提交暂存配置。

/** 目标版本镜像的合法 digest 行（`verifyImageSignatures` 的解析输入）。 */
const VERIFY_DIGEST_LINE = "Digest: sha256:" + "a".repeat(64) + "\n";

/**
 * 验签感知的 update runner：`docker buildx imagetools inspect` 返回合法 digest，
 * `cosign verify` 的退出码可注入（模拟验签失败）。
 */
function makeSignedUpdateRunner(
  events: UpdateEvent[],
  opts: {
    /** cosign verify 的退出码（0 = 通过）。 */
    verifyCode?: number;
    /** 每次 run 的旁路记录（断言镜像引用 / --env-file 用）。 */
    onRun?: (cmd: string, args: string[]) => void;
  } = {},
): CommandRunner {
  return {
    run(cmd, args) {
      events.push({ kind: "run", detail: cmd + " " + args.join(" ") });
      opts.onRun?.(cmd, args);
      if (cmd === "docker" && args[0] === "buildx") {
        return Promise.resolve({
          code: 0,
          stdout: VERIFY_DIGEST_LINE,
          stderr: "",
        });
      }
      if (cmd === "cosign") {
        return Promise.resolve({
          code: opts.verifyCode ?? 0,
          stdout: "",
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn(): SpawnHandle {
      throw new Error("update 测试不 spawn");
    },
  };
}

Deno.test("P1d update：drain enter/wait 在 up 前、exit 在 up（与 nginx 刷新）后", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();
    const result = await update({
      ...updateBase(dir, events, io),
      drain: makeDrain(events),
    });
    assertEquals(result.exitCode, 0, result.error ?? "");
    const enter = indexOfUpdate(events, "drain", "enter");
    const wait = indexOfUpdate(events, "drain", "wait");
    const up = indexOfUpdate(events, "run", "up -d --wait");
    const nginx = indexOfUpdate(events, "run", "--force-recreate");
    const exit = indexOfUpdate(events, "drain", "exit");
    assert(enter >= 0, "必须调用 drain.enter");
    assert(wait > enter, "wait 必须在 enter 之后");
    assert(up > wait, "启动目标栈必须在排空完成之后");
    assert(exit > up, "exit 必须在 up 之后");
    assert(exit > nginx, "exit 必须在反向代理刷新之后");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("P1d update：drain wait 失败 → 不 up、尽力 exit、暂存配置不提交", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const envFile = join(dir, ENV_FILE);
    const before = await Deno.readTextFile(envFile);
    const events: UpdateEvent[] = [];
    const contexts: DrainContext[] = [];
    const { io } = captureRenderIO();
    const result = await update({
      ...updateBase(dir, events, io),
      latest: true,
      fetcher: makeReleaseFetcher([readyUpdateRelease("v0.10.0")]),
      drain: makeDrain(
        events,
        { wait: { ok: false, code: "timeout", error: "等待超时" } },
        contexts,
      ),
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "等待排空失败");
    // 排空跑在**目标**配置上：--env-file 必须是暂存文件（升级失败后才被清理）
    assertStringIncludes(
      contexts[0]!.compose.envFile ?? "",
      ".env.prod.latest",
      "drain 必须使用暂存的目标配置，而不是旧 .env.prod",
    );
    assertEquals(contexts[0]!.compose.composeFile, join(dir, COMPOSE));
    assertEquals(
      events.some((e) => e.kind === "run" && e.detail.includes("up -d")),
      false,
      "排空失败不得启动目标栈",
    );
    assert(indexOfUpdate(events, "drain", "exit") >= 0, "必须尽力 exit");
    assertEquals(
      await Deno.readTextFile(envFile),
      before,
      "排空失败不得提交暂存配置",
    );
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(
      names.filter((n) => n.startsWith(".env.prod.latest")),
      [],
      "失败路径必须清理暂存配置",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("P1d update：waitForStack 失败 + drain exit 失败 → error 显式报告残留维护态", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();
    const result = await update({
      ...updateBase(dir, events, io),
      runner: makeUpdateRunner(
        events,
        (args) =>
          args.includes("--wait")
            ? { code: 1, stderr: "unhealthy" }
            : undefined,
      ),
      drain: makeDrain(events, {
        exit: { ok: false, code: "http_error", error: "500" },
      }),
    });
    assertEquals(result.exitCode, 1);
    // 基础失败原因仍在
    assertStringIncludes(result.error ?? "", WAIT_FAILURE_HINT);
    // exit 失败不得被丢弃：必须显式报告残留维护态与人工恢复命令
    assertStringIncludes(result.error ?? "", "维护模式");
    assertStringIncludes(result.error ?? "", "noj-cli maintain exit");
    // 目标栈失败后确实尝试过 exit
    assert(indexOfUpdate(events, "drain", "exit") >= 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("P1d update：旧 Core endpoint_unavailable → 告警并继续升级", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const events: UpdateEvent[] = [];
    const { io, stdout } = captureRenderIO();
    const unreachable: DrainResult = {
      ok: false,
      code: "endpoint_unavailable",
      error: "404",
    };
    const result = await update({
      ...updateBase(dir, events, io),
      drain: makeDrain(events, { enter: unreachable, exit: unreachable }),
    });
    assertEquals(result.exitCode, 0, result.error ?? "");
    assertEquals(
      indexOfUpdate(events, "drain", "wait"),
      -1,
      "旧 Core 没有端点，不得尝试 wait",
    );
    assert(indexOfUpdate(events, "run", "up -d --wait") >= 0, "必须继续升级");
    assertStringIncludes(stdout.join(""), "旧版本");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("P1d update：--skip-drain 完全不调用 drain", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();
    const result = await update({
      ...updateBase(dir, events, io),
      drain: makeDrain(events),
      skipDrain: true,
    });
    assertEquals(result.exitCode, 0, result.error ?? "");
    assertEquals(events.filter((e) => e.kind === "drain"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("P1d update：drain exit 失败 → 服务已起但显式报告半完成", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const envFile = join(dir, ENV_FILE);
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();
    const result = await update({
      ...updateBase(dir, events, io),
      latest: true,
      fetcher: makeReleaseFetcher([readyUpdateRelease("v0.10.0")]),
      drain: makeDrain(events, {
        exit: { ok: false, code: "http_error", error: "500" },
      }),
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "维护模式");
    assertStringIncludes(result.error ?? "", "noj-cli maintain exit");
    assert(
      indexOfUpdate(events, "run", "up -d --wait") >= 0,
      "目标栈必须已启动（半完成的另一半）",
    );
    // 升级本身成功：暂存配置照常提交（否则运行版本与 .env.prod 不一致）
    assertEquals(await configuredVersion(envFile), "v0.10.0");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── 回归：install 必须把二进制放到 <dir>/bin/noj-cli ─────────────
//
// 首次安装是"手动下载二进制 → 跑 install"；install 曾漏掉放置二进制这一步。
// 一处缺口造成三重后果：
//   1. PATH 注册静默跳过（registerCommand 见目标不存在就按"源码运行模式"告警）；
//   2. `uninstall --all` 完整性判据要求 bin/noj-cli → **永久自锁**；
//   3. cron 入口指向该文件 → 定时备份必然失败。
// 而三份文档都让用户执行 `/opt/neuro-oj/bin/noj-cli status`。

Deno.test("installCliBinary 以暂存+原子改名放置可执行文件", async () => {
  const { installCliBinary } = await import("./lifecycle/path.ts");
  const root = await Deno.makeTempDir();
  try {
    const dir = join(root, "install");
    await Deno.mkdir(dir, { recursive: true });
    // 造一个"像已编译产物"的源文件（文件名不是 deno*）
    const fakeCli = join(root, "noj-cli-linux-amd64");
    await Deno.writeTextFile(fakeCli, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(fakeCli, 0o755);

    const target = await installCliBinary({ dir, executable: fakeCli });
    assertEquals(target, join(dir, "bin/noj-cli"));
    const st = await Deno.stat(target!);
    assert(st.isFile, "必须是普通文件");
    assertEquals(st.mode! & 0o111, 0o111, "必须可执行（755）");
    // 不得残留暂存文件
    const leftovers: string[] = [];
    for await (const e of Deno.readDir(join(dir, "bin"))) {
      if (e.name.startsWith(".noj-cli.")) leftovers.push(e.name);
    }
    assertEquals(leftovers, [], "原子改名后不得残留暂存文件");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("installCliBinary 在源码运行模式（deno）下跳过，不复制 deno 自身", async () => {
  const { installCliBinary } = await import("./lifecycle/path.ts");
  const root = await Deno.makeTempDir();
  try {
    const dir = join(root, "install");
    await Deno.mkdir(dir, { recursive: true });
    const fakeDeno = join(root, "deno");
    await Deno.writeTextFile(fakeDeno, "#!/bin/sh\n");
    assertEquals(
      await installCliBinary({ dir, executable: fakeDeno }),
      null,
      "源码运行模式必须跳过（复制 deno 进安装目录会得到跑不了本 CLI 的文件）",
    );
    const exists = await Deno.stat(join(dir, "bin/noj-cli")).then(() => true)
      .catch(() => false);
    assertEquals(exists, false, "跳过时不得留下文件");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("install 成功后 <dir>/bin/noj-cli 存在（且能通过 uninstall 完整性判据）", async () => {
  // 注意：既有 install 测试都先调 `makeCliBinary(dir)`**预置** `bin/noj-cli`，
  // 因此从未覆盖"install 自己会不会放置二进制"这一路径——缺口正是这样藏住的。
  // 本用例**不预置**，断言 install 自己产出它。
  const dir = await Deno.makeTempDir();
  const root = await Deno.makeTempDir();
  try {
    const events: string[] = [];
    const records: RunnerCall[] = [];
    const passphrase = join(root, "backup-passphrase");
    const io = makeIO(
      ["v0.9.5", "oj.test-oj.cn", "y", "", "y", "", "", "y"],
      events,
    );
    // 源：一个"像已编译产物"的文件（文件名不是 deno*）
    const fakeCli = join(root, "noj-cli-linux-amd64");
    await Deno.writeTextFile(fakeCli, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(fakeCli, 0o755);

    await install({
      dir,
      repository: REPO,
      ref: REF,
      io,
      runner: makeRunner(records, () => undefined, events),
      fetcher: makeFetcher([], events),
      isTty: true,
      passphraseFile: passphrase,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(true),
      socketExists: () => Promise.resolve(true),
      binDir: join(root, "bin"),
      userHome: join(root, "home"),
      executable: fakeCli,
      now: new Date("2026-09-19T00:00:00Z"),
    });

    // 1) 二进制必须就位——文档让用户执行 `<dir>/bin/noj-cli status`
    const bin = join(dir, "bin/noj-cli");
    const st = await Deno.stat(bin).catch(() => null);
    assertEquals(st?.isFile, true, "install 必须把 CLI 放到 <dir>/bin/noj-cli");
    assertEquals(st!.mode! & 0o111, 0o111, "落地的二进制必须可执行");

    // 2) 于是 uninstall --all 的完整性判据可通过（解除自锁）
    await assertRemovableInstallDir(dir, { HOME: root });
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

// ── 回归：update --latest 用**旧** .env.prod 起栈（空升级）──────────
//
// 暂存文件（已写入目标版本）原本**只**用于最后提交，而 `composePull` /
// `waitForStack` 读的是仍然写着旧版本的 `.env.prod`。由于
// `docker-compose.prod.yml` 里镜像 tag 插值 `${NOJ_VERSION}`，结果是
// **拉旧镜像、起旧栈，却把新版本号写进配置并报"已升级"**。
//
// 正确做法是让**升级本身跑在暂存配置上**，成功后才覆盖。
// 既有的顺序测试只断言 `sync < backup < pull < wait`，从不检查 pull/wait
// **用的是哪个 env 文件**，所以它兼容两种实现、抓不到本缺陷。

Deno.test("update --latest 的 pull/up 必须使用暂存配置（目标版本），而非旧 .env.prod", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
    const envFile = join(dir, ENV_FILE);

    const envFilesUsed: string[] = [];
    const records: RunnerCall[] = [];
    const runner = makeRunner(records, (cmd, args) => {
      // 记录每次 compose 调用实际使用的 --env-file
      const i = args.indexOf("--env-file");
      if (cmd === "docker" && i >= 0) envFilesUsed.push(args[i + 1] ?? "");
      return undefined;
    });

    await update({
      dir,
      runner,
      // 注意：`latest` 是**布尔字段**（`opts.latest === true`），不是从 args 推的；
      // CLI 层由 `hasFlag(args, "--latest")` 传入（`prod/cli.ts`）。
      latest: true,
      args: ["--latest"],
      io: { stdout: () => {}, stderr: () => {}, jsonMode: false },
      isTty: false,
      // Releases 列表走 stub，部署文件走既有 ASSETS stub（URL 感知）
      fetcher: (url: string) => {
        // 注意：下载地址也含 `/releases/`（`/releases/download/<tag>/…`），
        // 必须解析 host 而不是做子串匹配，否则任意包含该串的 URL 都会被误判。
        let apiHost = false;
        try {
          apiHost = new URL(url).hostname === "api.github.com";
        } catch {
          apiHost = false;
        }
        if (url.includes("/releases?") || apiHost) {
          return Promise.resolve(
            new Response(
              JSON.stringify([
                {
                  tag_name: "v0.10.0",
                  draft: false,
                  prerelease: false,
                  assets: [
                    { name: "noj-cli-linux-amd64" },
                    { name: "noj-cli-linux-amd64.sha256" },
                    { name: "docker-compose.prod.yml" },
                    { name: "docker-compose.prod.yml.sha256" },
                    { name: "env.prod.example" },
                    { name: "env.prod.example.sha256" },
                    { name: "release-set.json" },
                    { name: "release-set.json.sha256" },
                  ],
                },
              ]),
              { status: 200 },
            ),
          );
        }
        return makeFetcher([], [])(url);
      },
      processEnv: { NOJ_BACKUP_PASSPHRASE_FILE: join(root, "pass") },
      backup: () => Promise.resolve({ ok: true, path: null, error: null }),
      warn: () => {},
      now: new Date("2026-09-19T00:00:00Z"),
    } as never);

    const staged = envFilesUsed.filter((p) => p !== envFile);
    assert(
      staged.length > 0,
      `pull/up 必须使用暂存配置（目标版本），实得 env-file 序列：${
        envFilesUsed.join(" | ")
      }`,
    );
    // 关键断言：**compose 调用期间**用的必须是暂存文件（而非真实 .env.prod），
    // 且该文件当时写着**目标版本**。注意不能在此处读文件内容——升级成功后
    // `commitConfigVersion` 已把它 rename 覆盖到 `.env.prod`（这正是期望行为），
    // 故暂存路径此刻已不存在。改为断言"最终 .env.prod 已是目标版本"
    // + "期间 use 的路径与真实配置不同"。
    for (const p of staged) {
      assertEquals(
        p === envFile,
        false,
        "compose 不得使用真实 .env.prod 跑升级（那会用旧 NOJ_VERSION 拉镜像）",
      );
    }
    const finalEnv = await Deno.readTextFile(envFile);
    assert(
      finalEnv.includes("v0.10.0"),
      `升级成功后 .env.prod 必须已是目标版本，实得：${finalEnv}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("P1a update：成功升级时事件顺序为 备份 → pull → 验签 → 启动（verify 早于 up）", async () => {
  const dir = await makeInstalledDir({
    NOJ_ENFORCE_IMAGE_SIGNATURES: "true",
  });
  try {
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();
    const result = await update({
      dir,
      runner: makeSignedUpdateRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {
        NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
      },
      cosignAvailable: () => Promise.resolve(true),
      warn: () => {},
      syncFiles: () => Promise.resolve(),
      backup: () => {
        events.push({ kind: "backup", detail: "v0.9.5" });
        return Promise.resolve({
          ok: true,
          path: "/tmp/x.nojbackup",
          error: null,
        });
      },
      now: new Date("2026-10-20T00:00:00Z"),
    });

    assertEquals(result.exitCode, 0, result.error ?? "");
    const backup = indexOfUpdate(events, "backup", "v0.9.5");
    const pull = indexOfUpdate(events, "run", " pull");
    const inspect = indexOfUpdate(events, "run", "imagetools inspect");
    const verify = indexOfUpdate(events, "run", "cosign verify");
    const up = indexOfUpdate(events, "run", "up -d --wait");
    assert(backup >= 0, "必须先备份");
    assert(pull > backup, "备份必须早于 pull");
    assert(inspect > pull, "镜像 digest 检查必须在 pull 之后");
    assert(verify > inspect, "cosign 校验必须在 digest 检查之后");
    assert(up > verify, "验签必须**早于**启动目标栈（旧实现的缺陷之一）");
    assert(up > pull, "启动必须在 pull 之后");
    // 部署元数据在启动之后记录，且版本、digest 来自同一份目标配置
    const manifest = await Deno.readTextFile(
      join(dir, "backups/current-deployment.txt"),
    );
    assertStringIncludes(manifest, "version=v0.9.5");
    assertStringIncludes(manifest, "noj-server sha256:");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("P1a update --latest：验签失败 → 绝无 up、不提交暂存配置、不记录部署元数据", async () => {
  const dir = await makeInstalledDir({
    NOJ_ENFORCE_IMAGE_SIGNATURES: "true",
  });
  try {
    const envFile = join(dir, ENV_FILE);
    const before = await Deno.readTextFile(envFile);
    const events: UpdateEvent[] = [];
    const { io, stderr } = captureRenderIO();
    const backupPath = "/tmp/x.nojbackup";
    const result = await update({
      dir,
      latest: true,
      fetcher: makeReleaseFetcher([readyUpdateRelease("v0.10.0")]),
      // 第一轮 digest 检查通过、cosign 校验失败：验签步骤必然被走到并失败。
      runner: makeSignedUpdateRunner(events, { verifyCode: 1 }),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {
        NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
      },
      cosignAvailable: () => Promise.resolve(true),
      warn: () => {},
      syncFiles: () => Promise.resolve(),
      backup: () =>
        Promise.resolve({ ok: true, path: backupPath, error: null }),
    });

    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "签名校验失败");
    assertStringIncludes(stderr.join(""), "签名校验失败");
    assertEquals(result.backupPath, backupPath, "备份确实执行过");
    // ① pull 已发生（序列是 pull → 验签），但**没有任何 up**
    assertEquals(
      events.some((e) => e.kind === "run" && e.detail.includes(" pull")),
      true,
      "验签前应已按顺序 pull 目标镜像",
    );
    assertEquals(
      events.some((e) => e.kind === "run" && e.detail.includes("up -d")),
      false,
      "验签失败后绝不允许启动目标栈",
    );
    assertEquals(
      events.some((e) =>
        e.kind === "run" && e.detail.includes("--force-recreate")
      ),
      false,
      "验签失败后绝不允许刷新反向代理（那也是 up）",
    );
    // ② 没有 commitConfigVersion：.env.prod 逐字节不变（仍是旧版本）
    assertEquals(await Deno.readTextFile(envFile), before);
    assertStringIncludes(before, "NOJ_VERSION=v0.9.5");
    // ③ 暂存配置被清理，不留下"待提交"的半成品
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names.filter((n) => n.startsWith(".env.prod.latest")), []);
    // ④ 不记录成功元数据
    await assertRejects(
      () => Deno.readTextFile(join(dir, "backups/current-deployment.txt")),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("P1a update --latest：验签镜像用目标版本、pull/up 读同一份暂存 env（唯一目标配置）", async () => {
  const dir = await makeInstalledDir({
    NOJ_ENFORCE_IMAGE_SIGNATURES: "true",
  });
  try {
    const envFile = join(dir, ENV_FILE);
    const images: string[] = [];
    const composeEnvFiles: string[] = [];
    const envTextDuringCompose: string[] = [];
    const oldEnvDuringVerify: string[] = [];
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();
    const runner = makeSignedUpdateRunner(events, {
      onRun: (cmd, args) => {
        const at = args.indexOf("--env-file");
        if (cmd === "docker" && at >= 0) {
          const used = args[at + 1] ?? "";
          // 只关心 pull 与两段 up：prepareAndCheck 的 config 仍校验真实 .env.prod。
          if (args.includes("pull") || args.includes("up")) {
            composeEnvFiles.push(used);
            // 调用发生**当场**读取该 env 文件：内容必须是目标版本（而非旧 .env.prod）。
            envTextDuringCompose.push(Deno.readTextFileSync(used));
          }
        }
        if (args[0] === "buildx") {
          images.push(args[3] ?? "");
          // 验签发生时旧 .env.prod 尚未提交（两段式）。
          oldEnvDuringVerify.push(Deno.readTextFileSync(envFile));
        }
      },
    });
    const result = await update({
      dir,
      latest: true,
      fetcher: makeReleaseFetcher([readyUpdateRelease("v0.10.0")]),
      runner,
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {
        NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
      },
      cosignAvailable: () => Promise.resolve(true),
      warn: () => {},
      syncFiles: () => Promise.resolve(),
      backup: () => Promise.resolve({ ok: true, path: null, error: null }),
    });

    assertEquals(result.exitCode, 0, result.error ?? "");
    // ① 验签的镜像引用用**目标版本** v0.10.0（不是旧 .env.prod 的 v0.9.5）
    assertEquals(images.length, 3, "judge 关闭时校验 3 个生产镜像");
    for (const image of images) {
      assertEquals(
        image.endsWith(":v0.10.0"),
        true,
        "验签必须以目标版本镜像引用进行，实得：" + image,
      );
    }
    // 验签时旧 .env.prod 仍是旧版本（目标配置来自暂存文件，而非已提交的旧配置）
    for (const text of oldEnvDuringVerify) {
      assertStringIncludes(text, "NOJ_VERSION=v0.9.5");
    }
    // ② pull 与两段 up 全部读**同一个**暂存 env 文件，且当时内容为目标版本
    assert(composeEnvFiles.length >= 3, "至少 pull + 两段 up");
    const staged = composeEnvFiles.filter((p) => p !== envFile);
    assertEquals(
      staged.length,
      composeEnvFiles.length,
      "pull/up 不得使用真实 .env.prod（那会用旧 NOJ_VERSION 拉镜像/起栈）",
    );
    assertEquals(
      new Set(composeEnvFiles).size,
      1,
      "pull 与 up 必须读同一份目标配置，实得：" + composeEnvFiles.join(" | "),
    );
    assertEquals(envTextDuringCompose.length, composeEnvFiles.length);
    for (const text of envTextDuringCompose) {
      assertStringIncludes(text, "NOJ_VERSION=v0.10.0");
    }
    // ③ 成功后暂存配置才被提交为 .env.prod（仍是两段式）
    assertStringIncludes(
      await Deno.readTextFile(envFile),
      "NOJ_VERSION=v0.10.0",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("P1a install：验签（步骤 6）先于 pull/up（步骤 7）——安装路径无同类缺陷", async () => {
  const dir = await makeInstalledDir({ NOJ_ENFORCE_IMAGE_SIGNATURES: "true" });
  try {
    const events: string[] = [];
    const calls: string[] = [];
    const records: RunnerCall[] = [];
    const passphrase = join(dir, "backup-passphrase");
    await writePassphraseFile(passphrase);

    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], events),
      runner: makeRunner(
        records,
        (cmd, args) =>
          cmd === "docker" && args[0] === "buildx"
            ? { stdout: VERIFY_DIGEST_LINE }
            : undefined,
      ),
      fetcher: makeFetcher(calls, events),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(true),
      warn: () => {},
    });

    assertEquals(result.verified.length, 3, "judge 关闭时校验 3 个生产镜像");
    const verify = records.findIndex((r) => r.cmd === "cosign");
    const pull = records.findIndex((r) => r.args.includes("pull"));
    const up = records.findIndex((r) => r.args.includes("up"));
    assert(verify >= 0, "install 必须验签");
    assert(pull > verify, "install 验签必须先于 pull");
    assert(up > verify, "install 验签必须先于启动目标栈");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
