/**
 * 生产生命周期测试：update 主序列与 --recover。
 *
 * 全部注入 runner / fetcher / IO，永不触碰真实 docker 与网络。
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { RELEASE_SET_FILE } from "./bootstrap.ts";
import {
  update,
  UPDATE_BACKUP_UNAVAILABLE_HINT,
  upgrade,
} from "./lifecycle.ts";
import {
  advanceUpgradeState,
  createUpgradeState,
  readUpgradeState,
  upgradeStatePath,
  writeUpgradeState,
} from "./upgrade-state.ts";
import { digestCandidateFiles } from "./lifecycle/upgrade.ts";
import {
  captureRenderIO,
  COMPOSE,
  COMPOSE_BODY,
  ENV_EXAMPLE,
  EXAMPLE_BODY,
  indexOfUpdate,
  makeDrain,
  makeInstalledDir,
  makeReleaseFetcher,
  makeUpdateRunner,
  NO_COLOR,
  readyUpdateRelease,
  releaseSetBody,
  SOCKET_PRESENT,
  UpdateEvent,
} from "./lifecycle_fixtures.ts";

Deno.test("update：默认按 NOJ_VERSION 升级，顺序为 同步 → 备份 → pull → wait → metadata", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const events: UpdateEvent[] = [];
    const { io, stdout } = captureRenderIO();
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(false),
      warn: () => {},
      passphraseFile: join(dir, "backup-passphrase"),
      syncFiles: (context) => {
        events.push({ kind: "sync", detail: context.ref });
        return Promise.resolve();
      },
      backup: (context) => {
        events.push({ kind: "backup", detail: context.version });
        return Promise.resolve({
          ok: true,
          path: join(dir, "backups/snapshot.nojbackup"),
          error: null,
        });
      },
      now: new Date("2026-09-19T00:00:00Z"),
    });

    // NOJ_ENFORCE_IMAGE_SIGNATURES=false 时验签跳过，因此 upgrade 应成功。
    assertEquals(result.exitCode, 0, result.error ?? "");
    assertEquals(result.from, "v0.9.5");
    assertEquals(result.to, "v0.9.5");
    assertEquals(result.latest, false);
    assertEquals(result.filesSynced, true);
    assertEquals(result.backupPath, join(dir, "backups/snapshot.nojbackup"));

    const sync = indexOfUpdate(events, "sync", "v0.9.5");
    const backup = indexOfUpdate(events, "backup", "v0.9.5");
    const pull = indexOfUpdate(events, "run", "pull");
    const wait = indexOfUpdate(events, "run", "up -d --wait");
    const nginx = indexOfUpdate(events, "run", "--force-recreate");
    const config = indexOfUpdate(events, "run", "config --quiet");
    assert(sync >= 0, "必须先同步部署文件");
    assert(backup > sync, "备份必须在文件同步之后");
    assert(pull > backup, "备份必须**先于**镜像拉取");
    assert(wait > pull, "健康等待必须在拉取之后");
    assert(nginx > wait, "nginx 刷新必须在健康等待之后");
    assert(config >= 0 && config < backup, "compose config 前置校验必须最早");
    assertStringIncludes(stdout.join(""), "同步生产部署文件：v0.9.5");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update --recover：沿用 checkpoint 目标版本与暂存发布集，不重新下载", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const staged = join(dir, ".update-staging-recover");
    await Deno.mkdir(staged, { recursive: true });
    await Deno.writeTextFile(join(staged, COMPOSE), COMPOSE_BODY);
    await Deno.writeTextFile(join(staged, ENV_EXAMPLE), EXAMPLE_BODY);
    await Deno.writeFile(
      join(staged, RELEASE_SET_FILE.target),
      releaseSetBody("v0.9.6"),
    );
    const files = await digestCandidateFiles(staged);
    const statePath = upgradeStatePath(dir);
    await Deno.mkdir(join(dir, "backups"), { recursive: true });
    await writeUpgradeState(
      statePath,
      advanceUpgradeState(
        createUpgradeState({
          runId: "run-recover",
          from: "v0.9.5",
          to: "v0.9.6",
          releaseSetRelease: "v0.9.6",
          now: new Date("2026-09-19T00:00:00Z"),
        }),
        "draining",
        { files, files_staged_dir: staged },
        new Date("2026-09-19T00:00:00Z"),
      ),
    );

    // 不带 --recover：明确拒绝，且不产生任何 compose 调用。
    const blockedEvents: UpdateEvent[] = [];
    const blocked = await update({
      dir,
      runner: makeUpdateRunner(blockedEvents),
      io: captureRenderIO().io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {},
      warn: () => {},
      upgradeStatePath: statePath,
      now: new Date("2026-09-19T00:00:00Z"),
    });
    assertEquals(blocked.exitCode, 1);
    assertStringIncludes(blocked.error ?? "", "--recover");
    assertEquals(blockedEvents.length, 0);

    const events: UpdateEvent[] = [];
    const { io, stdout } = captureRenderIO();
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
      upgradeStatePath: statePath,
      recover: true,
      fetcher: () => {
        throw new Error("恢复必须复用暂存文件，不得下载");
      },
      backup: () =>
        Promise.resolve({
          ok: true,
          path: join(dir, "backups/snapshot.nojbackup"),
          error: null,
        }),
      now: new Date("2026-09-19T00:00:00Z"),
    });

    assertEquals(result.exitCode, 0, result.error ?? "");
    assertEquals(result.to, "v0.9.6");
    assertEquals(result.filesSynced, true);
    assertStringIncludes(stdout.join(""), "复用未完成升级的暂存发布文件");
    // compose 一律指向复用后的暂存目录。
    assert(
      events.some((e) => e.kind === "run" && e.detail.includes(staged)),
      "恢复必须使用 checkpoint 记录的暂存目录",
    );
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), COMPOSE_BODY);
    const finalState = await readUpgradeState(statePath);
    assertEquals(finalState?.phase, "completed");
    assertEquals(finalState?.to, "v0.9.6");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update --recover：迁移失败保留候选文件、备份与未完成 checkpoint", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const staged = join(dir, ".update-staging-migrate");
    await Deno.mkdir(staged, { recursive: true });
    const candidateCompose = "services:\n  core:\n    image: noj-v096\n";
    await Deno.writeTextFile(join(staged, COMPOSE), candidateCompose);
    await Deno.writeTextFile(join(staged, ENV_EXAMPLE), EXAMPLE_BODY);
    await Deno.writeFile(
      join(staged, RELEASE_SET_FILE.target),
      releaseSetBody("v0.9.6"),
    );
    const files = await digestCandidateFiles(staged);
    const statePath = upgradeStatePath(dir);
    await Deno.mkdir(join(dir, "backups"), { recursive: true });
    await writeUpgradeState(
      statePath,
      advanceUpgradeState(
        createUpgradeState({
          runId: "run-migrate-fail",
          from: "v0.9.5",
          to: "v0.9.6",
          releaseSetRelease: "v0.9.6",
          now: new Date("2026-09-19T00:00:00Z"),
        }),
        "draining",
        { files, files_staged_dir: staged },
        new Date("2026-09-19T00:00:00Z"),
      ),
    );

    const events: UpdateEvent[] = [];
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io: captureRenderIO().io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {
        NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
      },
      warn: () => {},
      upgradeStatePath: statePath,
      recover: true,
      fetcher: () => {
        throw new Error("恢复必须复用暂存文件，不得下载");
      },
      backup: () =>
        Promise.resolve({
          ok: true,
          path: join(dir, "backups/snapshot.nojbackup"),
          error: null,
        }),
      migrate: () => Promise.reject(new Error("迁移失败：SQL 语法错误")),
      now: new Date("2026-09-19T00:00:00Z"),
    });

    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "迁移失败");
    // 迁移一旦开始就不再回退旧程序：候选文件已提交，旧文件组备份保留。
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), candidateCompose);
    const backupDirs: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory && entry.name.startsWith(".upgrade-backup-")) {
        backupDirs.push(entry.name);
      }
    }
    assert(backupDirs.length > 0, "迁移失败后必须保留旧发布文件备份");
    // 候选文件已提交到安装目录，暂存目录视为已消费并清理；checkpoint 不再指向它。
    assertEquals(
      await Deno.stat(staged).then(() => true, () => false),
      false,
    );
    const state = await readUpgradeState(statePath);
    assertEquals(state?.phase, "failed");
    assertEquals(state?.migration_started, true);
    assertEquals(state?.files_staged_dir, null);
    assertEquals(state?.files.length, files.length);
    assertStringIncludes(state?.error ?? "", "迁移失败");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update --recover：只读预检失败发生在排空前，候选文件不提交", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const staged = join(dir, ".update-staging-precheck");
    await Deno.mkdir(staged, { recursive: true });
    await Deno.writeTextFile(
      join(staged, COMPOSE),
      "services:\n  core:\n    image: noj-v096\n",
    );
    await Deno.writeTextFile(join(staged, ENV_EXAMPLE), EXAMPLE_BODY);
    await Deno.writeFile(
      join(staged, RELEASE_SET_FILE.target),
      releaseSetBody("v0.9.6"),
    );
    const files = await digestCandidateFiles(staged);
    const statePath = upgradeStatePath(dir);
    await Deno.mkdir(join(dir, "backups"), { recursive: true });
    await writeUpgradeState(
      statePath,
      advanceUpgradeState(
        createUpgradeState({
          runId: "run-precheck-fail",
          from: "v0.9.5",
          to: "v0.9.6",
          releaseSetRelease: "v0.9.6",
          now: new Date("2026-09-19T00:00:00Z"),
        }),
        "draining",
        { files, files_staged_dir: staged },
        new Date("2026-09-19T00:00:00Z"),
      ),
    );

    const events: UpdateEvent[] = [];
    const result = await update({
      dir,
      runner: makeUpdateRunner(
        events,
        (args) =>
          args.includes("check-upgrade")
            ? { code: 1, stderr: "ledger 前缀漂移" }
            : undefined,
      ),
      io: captureRenderIO().io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {
        NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
      },
      warn: () => {},
      upgradeStatePath: statePath,
      recover: true,
      fetcher: () => {
        throw new Error("恢复必须复用暂存文件，不得下载");
      },
      backup: () =>
        Promise.resolve({
          ok: true,
          path: join(dir, "backups/snapshot.nojbackup"),
          error: null,
        }),
      drain: makeDrain(events),
      now: new Date("2026-09-19T00:00:00Z"),
    });

    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "数据库升级预检失败");
    assertStringIncludes(result.error ?? "", "ledger 前缀漂移");
    // 旧配置与发布文件不变，也没有旧文件组备份。
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), COMPOSE_BODY);
    for await (const entry of Deno.readDir(dir)) {
      assert(
        !entry.name.startsWith(".upgrade-backup-"),
        "预检失败不得产生旧文件组备份",
      );
    }
    // 排空与迁移都没有开始。
    assertEquals(events.some((e) => e.kind === "drain"), false);
    assertEquals(
      events.some((e) => e.kind === "run" && e.detail.includes("up -d --wait")),
      false,
    );
    const state = await readUpgradeState(statePath);
    assertEquals(state?.phase, "failed");
    assertEquals(state?.migration_started, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update --recover：排空失败不提交候选文件、不执行迁移", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const staged = join(dir, ".update-staging-drain");
    await Deno.mkdir(staged, { recursive: true });
    await Deno.writeTextFile(
      join(staged, COMPOSE),
      "services:\n  core:\n    image: noj-v096\n",
    );
    await Deno.writeTextFile(join(staged, ENV_EXAMPLE), EXAMPLE_BODY);
    await Deno.writeFile(
      join(staged, RELEASE_SET_FILE.target),
      releaseSetBody("v0.9.6"),
    );
    const files = await digestCandidateFiles(staged);
    const statePath = upgradeStatePath(dir);
    await Deno.mkdir(join(dir, "backups"), { recursive: true });
    await writeUpgradeState(
      statePath,
      advanceUpgradeState(
        createUpgradeState({
          runId: "run-drain-fail",
          from: "v0.9.5",
          to: "v0.9.6",
          releaseSetRelease: "v0.9.6",
          now: new Date("2026-09-19T00:00:00Z"),
        }),
        "draining",
        { files, files_staged_dir: staged },
        new Date("2026-09-19T00:00:00Z"),
      ),
    );

    const events: UpdateEvent[] = [];
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io: captureRenderIO().io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {
        NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
      },
      warn: () => {},
      upgradeStatePath: statePath,
      recover: true,
      fetcher: () => {
        throw new Error("恢复必须复用暂存文件，不得下载");
      },
      backup: () =>
        Promise.resolve({
          ok: true,
          path: join(dir, "backups/snapshot.nojbackup"),
          error: null,
        }),
      drain: makeDrain(events, {
        wait: { ok: false, code: "timeout", error: "排空超时" },
      }),
      now: new Date("2026-09-19T00:00:00Z"),
    });

    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "排空超时");
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), COMPOSE_BODY);
    for await (const entry of Deno.readDir(dir)) {
      assert(
        !entry.name.startsWith(".upgrade-backup-"),
        "排空失败不得产生旧文件组备份",
      );
    }
    assertEquals(
      events.some((e) => e.kind === "run" && e.detail.includes("up -d --wait")),
      false,
    );
    const state = await readUpgradeState(statePath);
    assertEquals(state?.phase, "failed");
    assertEquals(state?.migration_started, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update：备份失败 → 退出码 1，且**零 pull / 零 up**", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
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
      syncFiles: () => Promise.resolve(),
      backup: () =>
        Promise.resolve({
          ok: false,
          path: null,
          error: "备份失败：gpg 不可用",
        }),
    });

    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "备份失败：gpg 不可用");
    assertStringIncludes(stderr.join(""), "备份失败：gpg 不可用");
    assertEquals(
      events.some((e) => e.kind === "run" && e.detail.includes(" pull")),
      false,
      "备份失败后不得拉取镜像",
    );
    assertEquals(
      events.some((e) => e.kind === "run" && e.detail.includes("up -d")),
      false,
      "备份失败后不得启动服务",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update：未接线备份（缺省注入点）→ 明确失败，绝不静默跳过", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
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
      syncFiles: () => Promise.resolve(),
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", UPDATE_BACKUP_UNAVAILABLE_HINT);
    assertEquals(events.filter((e) => e.kind === "run").length, 1);
    assertStringIncludes(events[0]!.detail, "config --quiet");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update --latest --recover：配置已提交但迁移未完成时不得 no-op", async () => {
  // 迁移阶段失败后 .env.prod 已是目标版本（from === to），而服务已停、维护
  // 模式未退出；恢复必须重新跑完迁移与启动，而不是报告“已是最新”。
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.6" });
  try {
    const statePath = upgradeStatePath(dir);
    await Deno.mkdir(join(dir, "backups"), { recursive: true });
    await writeUpgradeState(
      statePath,
      advanceUpgradeState(
        createUpgradeState({
          runId: "run-latest-recover",
          from: "v0.9.5",
          to: "v0.9.6",
          releaseSetRelease: "v0.9.6",
          now: new Date("2026-09-19T00:00:00Z"),
        }),
        "failed",
        { migration_started: true, error: "migrate 迁移失败" },
        new Date("2026-09-19T00:00:00Z"),
      ),
    );

    const events: UpdateEvent[] = [];
    let migrations = 0;
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io: captureRenderIO().io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {
        NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
      },
      warn: () => {},
      upgradeStatePath: statePath,
      latest: true,
      recover: true,
      fetcher: makeReleaseFetcher([readyUpdateRelease("v0.9.6")]),
      syncFiles: (ctx) => {
        events.push({ kind: "sync", detail: ctx.ref });
        return Promise.resolve();
      },
      backup: () =>
        Promise.resolve({
          ok: true,
          path: join(dir, "backups/snapshot.nojbackup"),
          error: null,
        }),
      migrate: () => {
        migrations++;
        return Promise.resolve();
      },
      now: new Date("2026-09-19T00:00:00Z"),
    });

    assertEquals(result.exitCode, 0, result.error ?? "");
    assertEquals(result.noOp, false, "未完成的升级不得被判定为 no-op");
    assertEquals(result.to, "v0.9.6");
    assertEquals(migrations, 1, "恢复必须重新执行迁移");
    assert(
      indexOfUpdate(events, "run", "up -d --wait") >= 0,
      "恢复必须启动目标栈",
    );
    assertEquals((await readUpgradeState(statePath))?.phase, "completed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upgrade 别名保留 --latest，与 update 行为一致", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.9.5" });
  try {
    const events: UpdateEvent[] = [];
    const urls: string[] = [];
    const result = await upgrade({
      dir,
      runner: makeUpdateRunner(events),
      io: captureRenderIO().io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {},
      warn: () => {},
      latest: true,
      fetcher: makeReleaseFetcher([readyUpdateRelease("v0.9.5")], urls),
      now: new Date("2026-09-19T00:00:00Z"),
    });
    assertEquals(result.exitCode, 0, result.error ?? "");
    assertEquals(result.latest, true, "别名不得丢弃 --latest");
    assertEquals(result.noOp, true, "已是最新时别名同样 no-op");
    assert(urls.length > 0, "必须查询最新 Release");
    assertEquals(events.length, 0, "no-op 不得调用 compose");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
