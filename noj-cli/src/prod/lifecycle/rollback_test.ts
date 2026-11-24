/**
 * 生产一键回滚（rollback）单元测试与 CLI 路由门禁。
 *
 * 全部注入 runner / syncFiles / drain / verifyBackup / restore，不触碰真实 Docker 或网络。
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { CommandRunner, SpawnHandle } from "../../runtime/command.ts";
import { run } from "../../cli.ts";
import { EXIT_OK, EXIT_USAGE } from "../../cli-commands/exit-codes.ts";
import { configuredVersion } from "../release.ts";
import {
  advanceUpgradeState,
  createUpgradeState,
  writeUpgradeState,
} from "../upgrade-state.ts";
import {
  captureRenderIO,
  COMPOSE,
  ENV_FILE,
  makeDrain,
  makeInstalledDir,
  NO_COLOR,
  SOCKET_PRESENT,
  type UpdateEvent,
  writePassphraseFile,
} from "../lifecycle_fixtures.ts";
import {
  assessRollbackMigrationRisk,
  parseSemverMajorMinor,
  rollback,
} from "./rollback.ts";

/** 记录 rollback 执行顺序的 fake runner（对 compose/buildx/cosign 返回成功）。 */
function makeRollbackRunner(
  events: UpdateEvent[],
  overrides: (
    cmd: string,
    args: string[],
  ) => { code?: number; stdout?: string; stderr?: string } | undefined = () =>
    undefined,
): CommandRunner {
  return {
    run(cmd, args) {
      events.push({ kind: "run", detail: cmd + " " + args.join(" ") });
      if (cmd === "docker" && args[0] === "buildx") {
        return Promise.resolve({
          code: 0,
          stdout: "Digest: sha256:" + "b".repeat(64) + "\n",
          stderr: "",
        });
      }
      if (cmd === "cosign") {
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({
        code: 0,
        stdout: "",
        stderr: "",
        ...(overrides(cmd, args) ?? {}),
      });
    },
    spawn(): SpawnHandle {
      throw new Error("rollback 测试不 spawn");
    },
  };
}

/** 构造最小可用的 .nojbackup 占位文件（实际解包由测试注入的 verifyBackup/restore 接管）。 */
async function createDummySnapshot(
  dir: string,
  name = "snapshot-prev.nojbackup",
): Promise<string> {
  const path = join(dir, "backups", name);
  await Deno.mkdir(join(dir, "backups"), { recursive: true });
  await Deno.writeTextFile(path, "dummy-snapshot-payload");
  return path;
}

Deno.test("parseSemverMajorMinor 与 assessRollbackMigrationRisk: 精准识别跨版本迁移风险", () => {
  assertEquals(parseSemverMajorMinor("v0.11.0"), { major: 0, minor: 11 });
  assertEquals(parseSemverMajorMinor("0.10.6-rc.1"), { major: 0, minor: 10 });
  assertEquals(parseSemverMajorMinor("invalid"), null);

  // 同次版本补丁回退且无迁移标记 → 无风险
  const patchSafe = assessRollbackMigrationRisk({
    currentVersion: "v0.11.2",
    targetVersion: "v0.11.1",
    upgradeState: null,
  });
  assertEquals(patchSafe.risky, false);
  assertEquals(patchSafe.reasons, []);

  // 跨 minor 版本 → 触发风险门禁
  const minorSpan = assessRollbackMigrationRisk({
    currentVersion: "v0.11.0",
    targetVersion: "v0.10.6",
    upgradeState: null,
  });
  assertEquals(minorSpan.risky, true);
  assert(minorSpan.reasons.some((r) => r.includes("跨越主/次版本")));

  // 同次版本但 upgrade-state.json 标记 migration_started=true → 触发风险门禁
  const migratingState = advanceUpgradeState(
    createUpgradeState({ runId: "r-mig", from: "v0.11.0", to: "v0.11.1" }),
    "migrating",
    { migration_started: true },
  );
  const migRisk = assessRollbackMigrationRisk({
    currentVersion: "v0.11.1",
    targetVersion: "v0.11.0",
    upgradeState: migratingState,
  });
  assertEquals(migRisk.risky, true);
  assert(migRisk.reasons.some((r) => r.includes("migration_started=true")));
});

Deno.test("rollback 安全门禁: 检测到跨版本迁移且未传 --restore-backup 或 --force-app-only 时安全拒绝", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.11.0" });
  try {
    const snapshot = await createDummySnapshot(dir);
    let state = createUpgradeState({
      runId: "upg-001",
      from: "v0.10.6",
      to: "v0.11.0",
    });
    state = advanceUpgradeState(state, "backed_up", { backup_path: snapshot });
    state = advanceUpgradeState(state, "migrating", {
      migration_started: true,
    });
    await writeUpgradeState(join(dir, "backups/upgrade-state.json"), state);

    const envBefore = await Deno.readTextFile(join(dir, ENV_FILE));
    const events: UpdateEvent[] = [];
    const { io, stderr } = captureRenderIO();

    const result = await rollback({
      dir,
      runner: makeRollbackRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      drain: makeDrain(events),
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.filesSwitched, false);
    assertStringIncludes(result.error ?? "", "安全门禁已阻止");
    assertStringIncludes(result.error ?? "", `--restore-backup ${snapshot}`);
    assertStringIncludes(result.error ?? "", "--force-app-only");
    assertStringIncludes(stderr.join(""), "安全门禁已阻止");

    // 确认零副作用：.env.prod 未改，且没有调用 drain 或 compose up/stop/pull
    assertEquals(await Deno.readTextFile(join(dir, ENV_FILE)), envBefore);
    assertEquals(events.some((e) => e.kind === "drain"), false);
    assertEquals(
      events.some((e) =>
        e.detail.includes("pull") || e.detail.includes("up -d")
      ),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("rollback --dry-run: 零副作用预演并输出完整计划与纯净 --json", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.11.0" });
  try {
    const passFile = join(dir, "backup.passphrase");
    await writePassphraseFile(passFile);
    const snapshot = await createDummySnapshot(dir);
    const envBefore = await Deno.readTextFile(join(dir, ENV_FILE));
    const composeBefore = await Deno.readTextFile(join(dir, COMPOSE));
    const events: UpdateEvent[] = [];
    const { io, stdout, stderr } = captureRenderIO(true);

    let verifyCalled = false;
    let restoreCalled = false;

    const result = await rollback({
      dir,
      runner: makeRollbackRunner(events),
      io,
      args: ["--json"],
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      to: "v0.10.6",
      restoreBackup: snapshot,
      passphraseFile: passFile,
      dryRun: true,
      drain: makeDrain(events),
      verifyBackup: () => {
        verifyCalled = true;
        return Promise.resolve({ pass: true, issues: [] });
      },
      restore: () => {
        restoreCalled = true;
        return Promise.resolve({ restored: ["postgres"] });
      },
    });

    assertEquals(result.exitCode, 0, result.error ?? "");
    assertEquals(result.dryRun, true);
    assertEquals(result.from, "v0.11.0");
    assertEquals(result.to, "v0.10.6");
    assertEquals(result.filesSwitched, false);
    assertEquals(verifyCalled, true, "dry-run 必须校验快照完整性");
    assertEquals(restoreCalled, false, "dry-run 绝不能真实恢复数据");
    assertEquals(
      result.steps.map((s) => s.name),
      [
        "preflight",
        "drain",
        "switch-files",
        "restore-backup",
        "start-and-wait",
      ],
    );

    // .env.prod 与 compose 均未改动，未执行 drain/pull/up/stop
    assertEquals(await Deno.readTextFile(join(dir, ENV_FILE)), envBefore);
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), composeBefore);
    assertEquals(events.some((e) => e.kind === "drain"), false);
    assertEquals(
      events.some((e) =>
        e.detail.includes("pull") || e.detail.includes("up -d") ||
        e.detail.includes("stop")
      ),
      false,
    );

    // --json 模式下 stdout 只有单个 JSON 文档，人类文字改道 stderr
    const parsed = JSON.parse(stdout.join(""));
    assertEquals(parsed.dryRun, true);
    assertEquals(parsed.from, "v0.11.0");
    assertEquals(parsed.to, "v0.10.6");
    assertStringIncludes(stderr.join(""), "[dry-run]");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("rollback --dry-run --restore-backup: 加密快照口令缺失时只读失败，不生成口令文件也不改写 .env.prod", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.11.0" });
  try {
    const snapshot = await createDummySnapshot(dir);
    const envBefore = await Deno.readTextFile(join(dir, ENV_FILE));
    const missingPassDir = join(dir, "missing-secret-dir");
    const missingPassFile = join(missingPassDir, "backup.passphrase");
    const envPassFile = join(dir, "missing-env-passphrase");
    const events: UpdateEvent[] = [];
    const warnings: string[] = [];
    let verifyCalled = false;
    let restoreCalled = false;

    const { io } = captureRenderIO();
    const flagResult = await rollback({
      dir,
      runner: makeRollbackRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      to: "v0.10.6",
      restoreBackup: snapshot,
      passphraseFile: missingPassFile,
      dryRun: true,
      processEnv: {},
      warn: (msg) => warnings.push(msg),
      drain: makeDrain(events),
      verifyBackup: () => {
        verifyCalled = true;
        return Promise.resolve({ pass: true, issues: [] });
      },
      restore: () => {
        restoreCalled = true;
        return Promise.resolve({ restored: ["postgres"] });
      },
    });

    assertEquals(flagResult.exitCode, 1);
    assertEquals(flagResult.dryRun, true);
    assertStringIncludes(flagResult.error ?? "", "GPG 备份口令文件不存在");
    assertStringIncludes(flagResult.error ?? "", missingPassFile);
    assertEquals(verifyCalled, false);
    assertEquals(restoreCalled, false);
    assertEquals(warnings, []);
    assertEquals(await Deno.readTextFile(join(dir, ENV_FILE)), envBefore);
    for (const absentPath of [missingPassFile, missingPassDir]) {
      let exists = true;
      try {
        await Deno.stat(absentPath);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) exists = false;
        else throw err;
      }
      assertEquals(exists, false, `dry-run 不应创建口令路径: ${absentPath}`);
    }

    // 未传 --passphrase-file 时按 NOJ_BACKUP_PASSPHRASE_FILE 解析，同样保持只读
    const { io: ioEnv } = captureRenderIO();
    const envResult = await rollback({
      dir,
      runner: makeRollbackRunner(events),
      io: ioEnv,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      to: "v0.10.6",
      restoreBackup: snapshot,
      dryRun: true,
      processEnv: { NOJ_BACKUP_PASSPHRASE_FILE: envPassFile },
      warn: (msg) => warnings.push(msg),
      drain: makeDrain(events),
      verifyBackup: () => {
        verifyCalled = true;
        return Promise.resolve({ pass: true, issues: [] });
      },
    });

    assertEquals(envResult.exitCode, 1);
    assertStringIncludes(envResult.error ?? "", "GPG 备份口令文件不存在");
    assertStringIncludes(envResult.error ?? "", envPassFile);
    assertEquals(verifyCalled, false);
    assertEquals(warnings, []);
    assertEquals(await Deno.readTextFile(join(dir, ENV_FILE)), envBefore);
    let envPassExists = true;
    try {
      await Deno.stat(envPassFile);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) envPassExists = false;
      else throw err;
    }
    assertEquals(envPassExists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("rollback 完整顺序: 缺省读取 upgrade-state.from 并按 校验→拉取→排空→停机→回切→恢复→启动→退出维护→归档 执行", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.11.0" });
  try {
    const passFile = join(dir, "backup.passphrase");
    await writePassphraseFile(passFile);
    const snapshot = await createDummySnapshot(dir);
    let state = createUpgradeState({
      runId: "upg-seq-1",
      from: "v0.10.6",
      to: "v0.11.0",
    });
    state = advanceUpgradeState(state, "backed_up", { backup_path: snapshot });
    state = advanceUpgradeState(state, "migrating", {
      migration_started: true,
    });
    await writeUpgradeState(join(dir, "backups/upgrade-state.json"), state);

    const events: UpdateEvent[] = [];
    const callOrder: string[] = [];
    const { io } = captureRenderIO();

    const result = await rollback({
      dir,
      runner: makeRollbackRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      restoreBackup: snapshot,
      passphraseFile: passFile,
      drain: {
        enter: (ctx) => {
          callOrder.push("drain.enter");
          return makeDrain(events).enter(ctx);
        },
        wait: (ctx) => {
          callOrder.push("drain.wait");
          return makeDrain(events).wait(ctx);
        },
        exit: (ctx) => {
          callOrder.push("drain.exit");
          return makeDrain(events).exit(ctx);
        },
      },
      syncFiles: async ({ dir: stagingDir, ref }) => {
        callOrder.push(`syncFiles:${ref}`);
        await Deno.writeTextFile(
          join(stagingDir, COMPOSE),
          `# version ${ref}\nservices:\n  core:\n    image: noj:${ref}\n`,
        );
      },
      verifyBackup: () => {
        callOrder.push("verifyBackup");
        return Promise.resolve({ pass: true, issues: [] });
      },
      restore: async () => {
        callOrder.push("restore");
        // 恢复时 .env.prod 必须已经切换为目标版本
        assertEquals(await configuredVersion(join(dir, ENV_FILE)), "v0.10.6");
        return { restored: ["postgres", "redis", "minio"] };
      },
    });

    assertEquals(result.exitCode, 0, result.error ?? "");
    assertEquals(result.from, "v0.11.0");
    assertEquals(result.to, "v0.10.6");
    assertEquals(result.filesSwitched, true);
    assertEquals(result.restoredBackup, snapshot);

    // 验证配置与部署文件已切换为 v0.10.6
    assertEquals(await configuredVersion(join(dir, ENV_FILE)), "v0.10.6");
    assertStringIncludes(
      await Deno.readTextFile(join(dir, COMPOSE)),
      "# version v0.10.6",
    );

    // 验证调用顺序：verifyBackup → syncFiles → drain.enter → drain.wait → restore → drain.exit
    const verifyIdx = callOrder.indexOf("verifyBackup");
    const syncIdx = callOrder.indexOf("syncFiles:v0.10.6");
    const enterIdx = callOrder.indexOf("drain.enter");
    const waitIdx = callOrder.indexOf("drain.wait");
    const restoreIdx = callOrder.indexOf("restore");
    const exitIdx = callOrder.indexOf("drain.exit");
    assert(verifyIdx >= 0 && syncIdx > verifyIdx);
    assert(enterIdx > syncIdx && waitIdx > enterIdx);
    assert(restoreIdx > waitIdx && exitIdx > restoreIdx);

    // 验证 compose stop 在 restore 之前，up -d --wait 在 restore 之后
    const stopIdx = events.findIndex((e) => e.detail.includes(" stop"));
    const upIdx = events.findIndex((e) => e.detail.includes("up -d --wait"));
    assert(stopIdx >= 0 && upIdx > stopIdx);

    // 验证已回滚的 upgrade-state.json 被归档，避免阻塞后续 update
    let currentExists = true;
    try {
      await Deno.stat(join(dir, "backups/upgrade-state.json"));
    } catch {
      currentExists = false;
    }
    assertEquals(currentExists, false, "upgrade-state.json 应已归档移除");
    const archived = await Deno.readTextFile(
      join(dir, "backups/upgrade-state.rolled-back-upg-seq-1.json"),
    );
    assertStringIncludes(archived, "upg-seq-1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("rollback --force-app-only: 允许显式跳过跨版本迁移门禁仅回切镜像与配置", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.11.0" });
  try {
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();

    const result = await rollback({
      dir,
      runner: makeRollbackRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      to: "v0.10.6",
      forceAppOnly: true,
      skipDrain: true,
      syncFiles: () => Promise.resolve(),
    });

    assertEquals(result.exitCode, 0, result.error ?? "");
    assertEquals(result.forceAppOnly, true);
    assertEquals(result.filesSwitched, true);
    assertEquals(await configuredVersion(join(dir, ENV_FILE)), "v0.10.6");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("rollback 快照校验失败: verifyBackup 不通过时在前置阶段中止，零副作用", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.11.0" });
  try {
    const passFile = join(dir, "backup.passphrase");
    await writePassphraseFile(passFile);
    const snapshot = await createDummySnapshot(dir);
    const envBefore = await Deno.readTextFile(join(dir, ENV_FILE));
    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();

    const result = await rollback({
      dir,
      runner: makeRollbackRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      to: "v0.10.6",
      restoreBackup: snapshot,
      passphraseFile: passFile,
      verifyBackup: () =>
        Promise.resolve({
          pass: false,
          issues: [{ level: "error", message: "sha256 校验失败" }],
        }),
    });

    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "快照校验未通过");
    assertStringIncludes(result.error ?? "", "sha256 校验失败");
    assertEquals(await Deno.readTextFile(join(dir, ENV_FILE)), envBefore);
    assertEquals(events.some((e) => e.detail.includes("pull")), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI 路由门禁: rollback help、参数校验与 --dry-run 分发", async () => {
  const origLog = console.log;
  const origErr = console.error;
  try {
    let out = "";
    let err = "";
    console.log = (...a: unknown[]) => {
      out += a.join(" ") + "\n";
    };
    console.error = (...a: unknown[]) => {
      err += a.join(" ") + "\n";
    };

    // 1. --help 正常展示 rollback 选项
    const helpCode = await run(["rollback", "--help"]);
    assertEquals(helpCode, EXIT_OK);
    assertStringIncludes(out, "--restore-backup");
    assertStringIncludes(out, "--force-app-only");
    assertStringIncludes(out, "--dry-run");

    // 2. 非法参数返回 EXIT_USAGE (2)
    err = "";
    const badPosCode = await run(["rollback", "unexpected-arg"]);
    assertEquals(badPosCode, EXIT_USAGE);
    assertStringIncludes(err, "不接受位置参数");

    err = "";
    const badTagCode = await run(["rollback", "--to", "not a tag"]);
    assertEquals(badTagCode, EXIT_USAGE);
    assertStringIncludes(err, "--to 版本格式非法");

    err = "";
    const badBackupCode = await run([
      "rollback",
      "--restore-backup",
      "/tmp/bad.tar",
    ]);
    assertEquals(badBackupCode, EXIT_USAGE);
    assertStringIncludes(err, ".nojbackup");

    // 3. 完整经过 cli.ts:run() 走 --dry-run --json（注入假 install 目录但需 docker compose config 校验，
    //    此处验证不可达未知旗标拦截已解除且正常到达生产分发层）
    const dir = await makeInstalledDir({ NOJ_VERSION: "v0.11.0" });
    try {
      out = "";
      err = "";
      // 若宿主机无 docker daemon 或 compose，prepareAndCheck 在第 6 步会报 EXIT_FAILURE (1) 而不是 EXIT_USAGE (2)
      // 证明 --dry-run 已被生产分发层放行并进入 rollback 流程
      const code = await run([
        "rollback",
        "--dir",
        dir,
        "--to",
        "v0.10.6",
        "--force-app-only",
        "--dry-run",
      ]);
      assert(
        code === EXIT_OK || code === 1,
        `不应返回用法错误 2，实际: ${code}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
});

Deno.test("rollback 部分文件替换失败后全部还原: 原有文件还原、新建文件删除、未触达文件保留", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.11.0" });
  try {
    const composeBefore = await Deno.readTextFile(join(dir, COMPOSE));
    const envBefore = await Deno.readTextFile(join(dir, ENV_FILE));
    const untouchedPath = join(dir, "zz-untouched.yml");
    await Deno.writeTextFile(untouchedPath, "original-untouched\n");

    const events: UpdateEvent[] = [];
    const { io } = captureRenderIO();

    const result = await rollback({
      dir,
      runner: makeRollbackRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      to: "v0.10.6",
      forceAppOnly: true,
      drain: makeDrain(events),
      syncFiles: async ({ dir: stagingDir, ref }) => {
        // 1) a-new.yml: 原先不存在的新建候选文件
        await Deno.writeTextFile(
          join(stagingDir, "a-new.yml"),
          `# new file for ${ref}\n`,
        );
        // 2) docker-compose.prod.yml: 原先已存在的文件（会被先替换再还原）
        await Deno.writeTextFile(
          join(stagingDir, COMPOSE),
          `# version ${ref}\nservices:\n  core:\n    image: noj:${ref}\n`,
        );
        // 3) z-fail.yml: 替换到此文件时注入失败
        await Deno.writeTextFile(
          join(stagingDir, "z-fail.yml"),
          `# fail file\n`,
        );
        // 4) zz-untouched.yml: 失败点之后的原有文件，不得被误删
        await Deno.writeTextFile(
          join(stagingDir, "zz-untouched.yml"),
          `# new untouched\n`,
        );
      },
      replaceFile: async (source, target) => {
        if (target.endsWith("z-fail.yml")) {
          throw new Error("模拟磁盘写入失败");
        }
        await Deno.copyFile(source, target);
      },
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.filesSwitched, false);
    assertStringIncludes(result.error ?? "", "回切配置文件失败");
    assertStringIncludes(result.error ?? "", "已还原全部旧配置与部署文件");

    // 1. 原有 docker-compose.prod.yml 与 .env.prod 已完整还原
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), composeBefore);
    assertEquals(await Deno.readTextFile(join(dir, ENV_FILE)), envBefore);

    // 2. 原先不存在的新建文件 a-new.yml 与失败点文件 z-fail.yml 均不存在
    for (const removedName of ["a-new.yml", "z-fail.yml"]) {
      let exists = true;
      try {
        await Deno.stat(join(dir, removedName));
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) exists = false;
        else throw err;
      }
      assertEquals(exists, false, `${removedName} 应已删除，不得残留混合配置`);
    }

    // 3. 失败点之后的原有文件 zz-untouched.yml 未被误删或篡改
    assertEquals(
      await Deno.readTextFile(untouchedPath),
      "original-untouched\n",
    );

    // 4. 失败后仍正常退出维护模式
    assertEquals(
      events.some((e) => e.kind === "drain" && e.detail === "exit"),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
