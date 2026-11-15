/**
 * 生产生命周期测试：update --latest、失败路径、别名与 JSON 输出。
 *
 * 全部注入 runner / fetcher / IO，永不触碰真实 docker 与网络。
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { update, UPDATE_UP_TO_DATE_HINT, upgrade } from "./lifecycle.ts";
import { WAIT_FAILURE_HINT } from "./lifecycle/steps.ts";
import { configuredVersion } from "./release.ts";
import {
  captureRenderIO,
  completeEnv,
  COMPOSE,
  COMPOSE_BODY,
  ENV_FILE,
  makeFetcher,
  makeInstalledDir,
  makeReleaseFetcher,
  makeUpdateRunner,
  NO_COLOR,
  readyUpdateRelease,
  SOCKET_PRESENT,
  UpdateEvent,
} from "./lifecycle_fixtures.ts";

Deno.test("update --latest：最新 == 当前 → no-op（零 compose、零备份、零配置写入）", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const before = await Deno.readTextFile(join(dir, ENV_FILE));
    const events: UpdateEvent[] = [];
    const { io, stdout } = captureRenderIO();
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {},
      warn: () => {},
      latest: true,
      fetcher: makeReleaseFetcher([readyUpdateRelease("v0.9.5")]),
      backup: () => {
        events.push({ kind: "backup", detail: "should-not-run" });
        return Promise.resolve({ ok: true, path: null, error: null });
      },
      syncFiles: () => {
        events.push({ kind: "sync", detail: "should-not-run" });
        return Promise.resolve();
      },
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.noOp, true);
    assertEquals(result.from, "v0.9.5");
    assertEquals(result.to, "v0.9.5");
    assertEquals(result.backupPath, null);
    assertEquals(result.filesSynced, false);
    assertEquals(events, [], "no-op 必须零 compose / 零备份 / 零同步");
    assertEquals(
      await Deno.readTextFile(join(dir, ENV_FILE)),
      before,
      ".env.prod 必须逐字节不变",
    );
    assertStringIncludes(stdout.join(""), UPDATE_UP_TO_DATE_HINT);
    assertStringIncludes(stdout.join(""), "当前生产版本：v0.9.5");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update --latest：0.9.5（无 v）与 v0.9.5 视为同一版本 → no-op", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "0.9.5" });
  try {
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {},
      warn: () => {},
      latest: true,
      fetcher: makeReleaseFetcher([readyUpdateRelease("v0.9.5")]),
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.noOp, true);
    assertEquals(events, []);
    assertEquals(
      await configuredVersion(join(dir, ENV_FILE)),
      "0.9.5",
      "no-op 不得改写版本前缀",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update --latest：有新版本 → 同步文件、升级、最后才提交 .env.prod", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const envFile = join(dir, ENV_FILE);
    const events: UpdateEvent[] = [];
    const { io, stdout } = captureRenderIO();
    let committedDuringUpgrade: string | null = null;
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {
        NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
      },
      warn: () => {},
      latest: true,
      fetcher: makeReleaseFetcher([readyUpdateRelease("v0.10.0")]),
      syncFiles: (context) => {
        events.push({ kind: "sync", detail: context.ref });
        // 同步期间配置仍是旧值（两段式：升级成功前不提交）
        return Deno.readTextFile(envFile).then((text) => {
          committedDuringUpgrade = text;
        });
      },
      backup: () =>
        Promise.resolve({ ok: true, path: "/tmp/x.nojbackup", error: null }),
    });

    assertEquals(result.exitCode, 0, result.error ?? "");
    // 目标版本是**原始 tag**（v0.10.0），不是去掉 v 的形式
    assertEquals(result.from, "v0.9.5");
    assertEquals(result.to, "v0.10.0");
    assertEquals(result.latest, true);
    assertStringIncludes(committedDuringUpgrade ?? "", "NOJ_VERSION=v0.9.5");
    assertStringIncludes(stdout.join(""), "最新稳定版本：v0.10.0");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update --latest：升级成功 → 提交 .env.prod（仅改 NOJ_VERSION，保留注释与顺序）", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const envFile = join(dir, ENV_FILE);
    await Deno.writeTextFile(
      envFile,
      "# 头部注释\nNOJ_VERSION=v0.9.5\n\n# 站点\n" +
        completeEnv({ NOJ_VERSION: "v0.9.5" }).split("\n").slice(1).join("\n"),
    );
    await Deno.chmod(envFile, 0o600);
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      // 进程环境给出 NOJ_BACKUP_PASSPHRASE_FILE：回填门**只**读进程环境，
      // 故此时不回填 .env.prod，对配置的逐字节断言才成立。
      processEnv: {
        NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
      },
      warn: () => {},
      latest: true,
      fetcher: makeReleaseFetcher([readyUpdateRelease("v0.10.0")]),
      syncFiles: () => Promise.resolve(),
      backup: () =>
        Promise.resolve({ ok: true, path: "/tmp/x.nojbackup", error: null }),
    });

    // 验签在 NOJ_ENFORCE_IMAGE_SIGNATURES=false 下跳过 → 升级成功
    assertEquals(result.exitCode, 0, result.error ?? "");
    assertEquals(result.to, "v0.10.0");
    assertEquals(await configuredVersion(envFile), "v0.10.0");
    const text = await Deno.readTextFile(envFile);
    assertStringIncludes(text, "# 头部注释");
    assertStringIncludes(text, "# 站点");
    assertEquals(((await Deno.stat(envFile)).mode ?? 0) & 0o777, 0o600);
    // 目录内不得残留暂存文件
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names.filter((n) => n.startsWith(".env.prod.latest")), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update --latest：升级失败 → .env.prod 逐字节不变且暂存文件被清理", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const envFile = join(dir, ENV_FILE);
    const before = await Deno.readTextFile(envFile);
    const events: UpdateEvent[] = [];
    const { io, stderr } = captureRenderIO();
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      // 进程环境给出 NOJ_BACKUP_PASSPHRASE_FILE：回填门**只**读进程环境，
      // 故此时不回填 .env.prod，对配置的逐字节断言才成立。
      processEnv: {
        NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
      },
      warn: () => {},
      latest: true,
      fetcher: makeReleaseFetcher([readyUpdateRelease("v0.10.0")]),
      syncFiles: () => Promise.resolve(),
      backup: () =>
        Promise.resolve({ ok: false, path: null, error: "备份失败" }),
    });

    assertEquals(result.exitCode, 1);
    assertEquals(await Deno.readTextFile(envFile), before);
    assertStringIncludes(stderr.join(""), "备份失败");
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

Deno.test("update --latest：Release 查询失败 → 退出码 1 且零副作用", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const envFile = join(dir, ENV_FILE);
    const before = await Deno.readTextFile(envFile);
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {},
      warn: () => {},
      latest: true,
      fetcher: () => Promise.resolve(new Response("{}", { status: 500 })),
    });

    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "无法获取 Release 列表");
    assertEquals(events, [], "查询失败后不得调用任何 compose");
    assertEquals(await Deno.readTextFile(envFile), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update --latest：无资产就绪版本 → 报错且不改配置", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const envFile = join(dir, ENV_FILE);
    const before = await Deno.readTextFile(envFile);
    const { io } = captureRenderIO();
    const result = await update({
      dir,
      runner: makeUpdateRunner([]),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {},
      warn: () => {},
      latest: true,
      fetcher: makeReleaseFetcher([
        { tag_name: "v0.10.0", draft: false, prerelease: false, assets: [] },
      ]),
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "没有发现资产就绪的正式 Release");
    assertEquals(await Deno.readTextFile(envFile), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update：缺 .env.prod → 明确报错且零 compose", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io,
      color: NO_COLOR,
      processEnv: {},
      warn: () => {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "未找到生产配置");
    assertEquals(events, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update：.env.prod 缺 NOJ_VERSION → 明确报错且零 compose", async () => {
  const dir = await makeInstalledDir();
  try {
    const envFile = join(dir, ENV_FILE);
    await Deno.writeTextFile(envFile, "DOMAIN=oj.test-oj.cn\n");
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io,
      color: NO_COLOR,
      processEnv: {},
      warn: () => {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "生产配置缺少 NOJ_VERSION");
    assertEquals(events, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update：前置校验失败（缺 compose 文件）→ 不备份、不 pull", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    await Deno.remove(join(dir, COMPOSE));
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {},
      warn: () => {},
      syncFiles: () => Promise.resolve(),
      backup: () => {
        events.push({ kind: "backup", detail: "should-not-run" });
        return Promise.resolve({ ok: true, path: null, error: null });
      },
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "找不到生产 Compose 文件");
    assertEquals(events, [], "前置失败必须零副作用");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update：文件同步失败 → 退出码 1，不备份、不 pull，暂存配置被清理", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const envFile = join(dir, ENV_FILE);
    const before = await Deno.readTextFile(envFile);
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {},
      warn: () => {},
      latest: true,
      fetcher: makeReleaseFetcher([readyUpdateRelease("v0.10.0")]),
      syncFiles: () => Promise.reject(new Error("同步失败：HTTP 404")),
      backup: () => {
        events.push({ kind: "backup", detail: "should-not-run" });
        return Promise.resolve({ ok: true, path: null, error: null });
      },
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "同步失败：HTTP 404");
    assertEquals(events, []);
    assertEquals(await Deno.readTextFile(envFile), before);
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names.filter((n) => n.startsWith(".env.prod.latest")), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update：compose pull 失败 → 退出码 1，且不执行 up", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();
    const result = await update({
      dir,
      runner: makeUpdateRunner(
        events,
        (args) =>
          args.includes("pull")
            ? { code: 1, stderr: "pull failed" }
            : undefined,
      ),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      // 进程环境给出 NOJ_BACKUP_PASSPHRASE_FILE：回填门**只**读进程环境，
      // 故此时不回填 .env.prod，对配置的逐字节断言才成立。
      processEnv: {
        NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
      },
      warn: () => {},
      syncFiles: () => Promise.resolve(),
      backup: () =>
        Promise.resolve({ ok: true, path: "/tmp/x.nojbackup", error: null }),
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "pull failed");
    assertEquals(
      events.some((e) => e.detail.includes("up -d")),
      false,
      "拉取失败后不得启动服务",
    );
    // 备份路径如实回传（备份确实做过）
    assertEquals(result.backupPath, "/tmp/x.nojbackup");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update：健康检查失败 → 退出码 1 且回传备份路径", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();
    const result = await update({
      dir,
      runner: makeUpdateRunner(
        events,
        (args) =>
          args.includes("--wait")
            ? { code: 1, stderr: "unhealthy" }
            : undefined,
      ),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      // 进程环境给出 NOJ_BACKUP_PASSPHRASE_FILE：回填门**只**读进程环境，
      // 故此时不回填 .env.prod，对配置的逐字节断言才成立。
      processEnv: {
        NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
      },
      warn: () => {},
      syncFiles: () => Promise.resolve(),
      backup: () =>
        Promise.resolve({ ok: true, path: "/tmp/x.nojbackup", error: null }),
    });
    assertEquals(result.exitCode, 1);
    assertEquals(result.error, WAIT_FAILURE_HINT);
    assertEquals(result.backupPath, "/tmp/x.nojbackup");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upgrade：是 update 的别名，行为逐字一致", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const shared = {
      runner: makeUpdateRunner([]),
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
    const viaUpdate = await update({
      ...shared,
      dir,
      io: captureRenderIO().io,
    });
    const viaUpgrade = await upgrade({
      ...shared,
      dir,
      io: captureRenderIO().io,
    });
    assertEquals(viaUpgrade.exitCode, viaUpdate.exitCode);
    assertEquals(viaUpgrade.from, viaUpdate.from);
    assertEquals(viaUpgrade.to, viaUpdate.to);
    assertEquals(viaUpgrade.latest, false);
    assertEquals(viaUpgrade.filesSynced, viaUpdate.filesSynced);
    assertEquals(viaUpgrade.backupPath, viaUpdate.backupPath);

    // 显式传 --latest 时 upgrade 仍按固定版本处理（别名不改变模式）
    const forced = await upgrade({
      ...shared,
      dir,
      io: captureRenderIO().io,
      latest: true,
    });
    assertEquals(forced.latest, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update：默认 syncFiles 用 downloadReleaseFiles（overwrite:true，资产被覆盖、.env.prod 不动）", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const envFile = join(dir, ENV_FILE);
    const before = await Deno.readTextFile(envFile);
    const calls: string[] = [];
    const events: UpdateEvent[] = [];
    // 既有 makeFetcher 的事件参数是 string[]（bootstrap 测试的时间轴）；这里只关心
    // 下载次数与产物，故给它一条独立的时间轴，不与 UpdateEvent 混用。
    const fetchEvents: string[] = [];
    const { io } = captureRenderIO();
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      // 进程环境给出 NOJ_BACKUP_PASSPHRASE_FILE：回填门**只**读进程环境，
      // 故此时不回填 .env.prod，对配置的逐字节断言才成立。
      processEnv: {
        NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
      },
      warn: () => {},
      fetcher: makeFetcher(calls, fetchEvents),
      backup: () =>
        Promise.resolve({ ok: true, path: "/tmp/x.nojbackup", error: null }),
    });

    assertEquals(result.exitCode, 0, result.error ?? "");
    assertEquals(calls.length, 6, "必须下载 3 个资产 + 3 个 .sha256");
    // 资产以 overwrite:true 重新拉取（既有 compose 存在也不被拒绝）
    assertEquals(
      await Deno.readTextFile(join(dir, COMPOSE)),
      COMPOSE_BODY,
    );
    assertEquals(
      await Deno.readTextFile(envFile),
      before,
      ".env.prod 必须不受同步影响",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update --json：stdout 只有 JSON 文档，人类文字改道 stderr", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const events: UpdateEvent[] = [];
    const { io, stdout, stderr } = captureRenderIO(true);
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io,
      color: NO_COLOR,
      args: ["--json"],
      socketExists: SOCKET_PRESENT,
      // 进程环境给出 NOJ_BACKUP_PASSPHRASE_FILE：回填门**只**读进程环境，
      // 故此时不回填 .env.prod，对配置的逐字节断言才成立。
      processEnv: {
        NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
      },
      warn: () => {},
      syncFiles: () => Promise.resolve(),
      backup: () =>
        Promise.resolve({ ok: true, path: "/tmp/x.nojbackup", error: null }),
    });

    assertEquals(result.exitCode, 0, result.error ?? "");
    assertEquals(
      stdout.join(""),
      JSON.stringify(
        {
          dir,
          from: "v0.9.5",
          to: "v0.9.5",
          state: "running",
          noOp: false,
          latest: false,
          filesSynced: true,
          backupPath: "/tmp/x.nojbackup",
          error: null,
        },
        null,
        2,
      ) + "\n",
    );
    assertEquals(stdout.join("").includes("\x1b["), false);
    assertStringIncludes(stderr.join(""), "同步生产部署文件：v0.9.5");
    // 人类文字绝不进 stdout
    assertEquals(stdout.join("").includes("同步生产部署文件"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update --latest --json：no-op 也输出唯一 JSON 文档", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const { io, stdout, stderr } = captureRenderIO(true);
    const result = await update({
      dir,
      runner: makeUpdateRunner([]),
      io,
      color: NO_COLOR,
      args: ["--json"],
      socketExists: SOCKET_PRESENT,
      processEnv: {},
      warn: () => {},
      latest: true,
      fetcher: makeReleaseFetcher([readyUpdateRelease("v0.9.5")]),
    });
    assertEquals(result.noOp, true);
    assertEquals(
      stdout.join(""),
      JSON.stringify(
        {
          dir,
          from: "v0.9.5",
          to: "v0.9.5",
          state: "running",
          noOp: true,
          latest: true,
          filesSynced: false,
          backupPath: null,
          error: null,
        },
        null,
        2,
      ) + "\n",
    );
    assertStringIncludes(stderr.join(""), UPDATE_UP_TO_DATE_HINT);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update：升级时 prepare_and_check 与 install 同源（六步前置含 compose config）", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();
    await update({
      dir,
      runner: makeUpdateRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      // 进程环境给出 NOJ_BACKUP_PASSPHRASE_FILE：回填门**只**读进程环境，
      // 故此时不回填 .env.prod，对配置的逐字节断言才成立。
      processEnv: {
        NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
      },
      warn: () => {},
      syncFiles: () => Promise.resolve(),
      backup: () =>
        Promise.resolve({ ok: true, path: "/tmp/x.nojbackup", error: null }),
    });
    const config = events.findIndex((e) => e.detail.includes("config --quiet"));
    assert(config >= 0, "必须跑 compose config 前置校验");
    // 参数形状由 composeArgs 唯一保证：--env-file / -f 齐全，judge 关闭时不带 profile
    assertStringIncludes(events[config]!.detail, "compose --project-directory");
    assertStringIncludes(events[config]!.detail, "--env-file");
    assertStringIncludes(events[config]!.detail, "-f");
    assertEquals(events[config]!.detail.includes("--profile judge"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
