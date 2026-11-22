/**
 * Issue #624 验收测试：`update` 升级前按数据量与同/异分区的整体磁盘空间预检。
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { CommandRunner, SpawnHandle } from "../runtime/command.ts";
import { UsageError } from "../util/args.ts";
import { createUpdateDiskChecker, runProdUpdate } from "./commands/update.ts";
import { type DiskPartitionInfo, GIB, MIB } from "./disk-space.ts";
import { update } from "./lifecycle.ts";
import {
  captureRenderIO,
  ENV_FILE,
  makeInstalledDir,
  makeReleaseFetcher,
  makeUpdateRunner,
  NO_COLOR,
  readyUpdateRelease,
  SOCKET_PRESENT,
  type UpdateEvent,
} from "./lifecycle_fixtures.ts";

function part(
  mountPoint: string,
  filesystem: string,
  availableBytes: number,
): DiskPartitionInfo {
  return {
    filesystem,
    mountPoint,
    totalBytes: 200 * GIB,
    usedBytes: 200 * GIB - availableBytes,
    availableBytes,
    usedPercent: 80,
    targetPath: mountPoint,
    probedPath: mountPoint,
  };
}

Deno.test("update: 磁盘预检失败时零 compose 调用、零同步、零备份、零磁盘写入", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.10.6" });
  try {
    const beforeEnv = await Deno.readTextFile(join(dir, ENV_FILE));
    const events: UpdateEvent[] = [];
    const { io, stderr } = captureRenderIO();

    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {},
      latest: true,
      fetcher: makeReleaseFetcher([readyUpdateRelease("v0.11.0")]),
      warn: () => {},
      checkDiskSpace: () =>
        Promise.resolve({
          ok: false,
          error:
            "升级前磁盘可用空间不足（挂载点 /）：需要 5.7 GiB / 可用 3 GiB",
        }),
      syncFiles: () => {
        events.push({ kind: "sync", detail: "should-not-run" });
        return Promise.resolve();
      },
      backup: () => {
        events.push({ kind: "backup", detail: "should-not-run" });
        return Promise.resolve({
          ok: true,
          path: "/tmp/x.nojbackup",
          error: null,
        });
      },
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.filesSynced, false);
    assertEquals(result.backupPath, null);
    assertStringIncludes(result.error ?? "", "可用空间不足");
    assertStringIncludes(result.error ?? "", "需要 5.7 GiB");
    assertStringIncludes(result.error ?? "", "可用 3 GiB");
    assertStringIncludes(stderr.join(""), "可用空间不足");
    assertEquals(events, [], "空间不足时绝不得调用 compose、sync 或 backup");
    assertEquals(
      await Deno.readTextFile(join(dir, ENV_FILE)),
      beforeEnv,
      ".env.prod 必须逐字节不变",
    );
    const entries = await Array.fromAsync(Deno.readDir(dir));
    assertEquals(
      entries.some((e) =>
        e.name.startsWith(".env.prod.latest") ||
        e.name.startsWith(".update-staging-") ||
        e.name === "backups"
      ),
      false,
      "空间不足时不得创建暂存文件、暂存目录或 backups 目录",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update --latest: 已是最新时直接 no-op，不触发磁盘预检", async () => {
  const dir = await makeInstalledDir({ NOJ_VERSION: "v0.11.0" });
  try {
    let checked = false;
    const events: UpdateEvent[] = [];
    const result = await update({
      dir,
      runner: makeUpdateRunner(events),
      io: captureRenderIO().io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {},
      latest: true,
      fetcher: makeReleaseFetcher([readyUpdateRelease("v0.11.0")]),
      warn: () => {},
      checkDiskSpace: () => {
        checked = true;
        return Promise.resolve({ ok: true });
      },
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.noOp, true);
    assertEquals(checked, false);
    assertEquals(events, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createUpdateDiskChecker: 同分区/异分区判定与静态下限零估算快速拦截", async () => {
  const dir = await makeInstalledDir({
    NOJ_VERSION: "v0.10.6",
    JUDGE_ENABLED: "false",
  });
  try {
    const events: UpdateEvent[] = [];
    let estimateCalls = 0;
    const estimate = {
      postgresBytes: 1 * GIB,
      redisBytes: 0,
      minioBytes: 1 * GIB,
      totalBytes: 2 * GIB,
      sources: ["PostgreSQL", "MinIO"],
    };

    // 1. 静态下限 + 镜像拉取预估直接超出可用空间 -> 不调用 estimateDataSize
    const floorChecker = createUpdateDiskChecker({
      minFreeMb: 1024,
      runner: makeUpdateRunner(events),
      processEnv: {},
      streaming: true,
      probePartition: () => Promise.resolve(part("/", "/dev/vda1", 2 * GIB)),
      probeDockerRootDir: () => Promise.resolve("/var/lib/docker"),
      estimateDataSize: () => {
        estimateCalls += 1;
        return Promise.resolve(estimate);
      },
    });
    const floorRes = await update({
      dir,
      runner: makeUpdateRunner(events),
      io: captureRenderIO().io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {},
      warn: () => {},
      checkDiskSpace: floorChecker,
      syncFiles: () => Promise.resolve(),
      backup: () => Promise.resolve({ ok: true, path: "/tmp/x", error: null }),
    });
    assertEquals(floorRes.exitCode, 1);
    assertEquals(
      estimateCalls,
      0,
      "静态下限+镜像预估都不够时不得起容器做数据估算",
    );
    assertEquals(events, []);

    // 2. 同分区 5 GiB：静态下限(2.5 GiB)够，但加上 2 GiB 数据后需 5.7 GiB -> 拒绝且零 compose
    const sameReject = await update({
      dir,
      runner: makeUpdateRunner(events),
      io: captureRenderIO().io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {},
      warn: () => {},
      checkDiskSpace: createUpdateDiskChecker({
        minFreeMb: 1024,
        runner: makeUpdateRunner(events),
        processEnv: {},
        streaming: true,
        probePartition: () => Promise.resolve(part("/", "/dev/vda1", 5 * GIB)),
        probeDockerRootDir: () => Promise.resolve("/var/lib/docker"),
        estimateDataSize: () => Promise.resolve(estimate),
      }),
      syncFiles: () => Promise.resolve(),
      backup: () => Promise.resolve({ ok: true, path: "/tmp/x", error: null }),
    });
    assertEquals(sameReject.exitCode, 1);
    assertStringIncludes(sameReject.error ?? "", "5.7 GiB");
    assertStringIncludes(sameReject.error ?? "", "5 GiB");
    assertEquals(events, []);

    // 3. 异分区（backups=5 GiB 足够备份 4.2 GiB，docker=1 GiB 不足镜像 1.5 GiB）-> 拒绝
    const splitReject = await update({
      dir,
      runner: makeUpdateRunner(events),
      io: captureRenderIO().io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {},
      warn: () => {},
      checkDiskSpace: createUpdateDiskChecker({
        minFreeMb: 1024,
        runner: makeUpdateRunner(events),
        processEnv: {},
        streaming: true,
        probePartition: (target) =>
          Promise.resolve(
            target.includes("docker")
              ? part("/var/lib/docker", "/dev/vdb1", 1 * GIB)
              : part("/opt/backups", "/dev/vda1", 5 * GIB),
          ),
        probeDockerRootDir: () => Promise.resolve("/var/lib/docker"),
        estimateDataSize: () => Promise.resolve(estimate),
      }),
      syncFiles: () => Promise.resolve(),
      backup: () => Promise.resolve({ ok: true, path: "/tmp/x", error: null }),
    });
    assertEquals(splitReject.exitCode, 1);
    assertStringIncludes(splitReject.error ?? "", "/var/lib/docker");
    assertEquals(events, []);

    // 4. 异分区两者各自达标（backups=5 GiB, docker=2 GiB）-> 预检通过并继续升级
    let backupRan = false;
    const splitOk = await update({
      dir,
      runner: makeUpdateRunner(events),
      io: captureRenderIO().io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      processEnv: {
        NOJ_BACKUP_PASSPHRASE_FILE: join(dir, "backup-passphrase"),
      },
      warn: () => {},
      checkDiskSpace: createUpdateDiskChecker({
        minFreeMb: 1024,
        runner: makeUpdateRunner(events),
        processEnv: {},
        streaming: true,
        probePartition: (target) =>
          Promise.resolve(
            target.includes("docker")
              ? part("/var/lib/docker", "/dev/vdb1", 2 * GIB)
              : part("/opt/backups", "/dev/vda1", 5 * GIB),
          ),
        probeDockerRootDir: () => Promise.resolve("/var/lib/docker"),
        estimateDataSize: () => Promise.resolve(estimate),
      }),
      syncFiles: () => Promise.resolve(),
      backup: () => {
        backupRan = true;
        return Promise.resolve({
          ok: true,
          path: join(dir, "backups/snap.nojbackup"),
          error: null,
        });
      },
    });
    assertEquals(splitOk.exitCode, 0, splitOk.error ?? "");
    assertEquals(backupRan, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runProdUpdate: --min-free-mb 与 runner 探测空间不足时零生命周期 compose 调用、零备份", async () => {
  const dir = await makeInstalledDir({
    NOJ_VERSION: "v0.10.6",
    JUDGE_ENABLED: "false",
  });
  try {
    const lifecycleCalls: string[] = [];
    const runner: CommandRunner = {
      run(cmd, args) {
        const joined = [cmd, ...args].join(" ");
        if (cmd === "df") {
          // 可用 2 GiB
          return Promise.resolve({
            code: 0,
            stdout:
              "Filesystem 1024-blocks Used Available Capacity Mounted on\n" +
              `/dev/vda1 104857600 102760448 ${2 * 1024 * 1024} 98% /\n`,
            stderr: "",
          });
        }
        if (cmd === "docker" && args[0] === "info") {
          return Promise.resolve({
            code: 0,
            stdout: "/var/lib/docker\n",
            stderr: "",
          });
        }
        lifecycleCalls.push(joined);
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      spawn(): SpawnHandle {
        throw new Error("空间不足时绝不得 spawn");
      },
    };

    const res = await runProdUpdate(
      dir,
      ["--min-free-mb", String(1024)],
      {
        runner,
        io: {
          write: () => {},
          readLine: () => Promise.resolve(""),
          readSecret: () => Promise.resolve(""),
        },
        isTty: () => false,
        processEnv: {},
      },
    );

    assertEquals(res.exitCode, 1);
    assertStringIncludes(res.error ?? "", "可用空间不足");
    assertStringIncludes(res.error ?? "", "需要");
    assertStringIncludes(res.error ?? "", "可用");
    // 静态 1024 MiB + 1536 MiB 镜像 = 2560 MiB > 2 GiB，故零 compose 调用
    assertEquals(lifecycleCalls, [], "空间不足时绝不得触发 compose 或备份");
    assertEquals(
      await Deno.stat(join(dir, "backups")).then(() => true).catch(() => false),
      false,
    );

    // 非法 --min-free-mb 在任何外部命令之前报用法错误
    await assertRejects(
      () =>
        runProdUpdate(dir, ["--min-free-mb", "-5"], {
          runner,
          processEnv: {},
        }),
      UsageError,
      "--min-free-mb",
    );
    assertEquals(
      lifecycleCalls,
      [],
      "参数非法时绝不得触发任何 compose 调用",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runProdUpdate: .env.prod 与进程环境 NOJ_BACKUP_MIN_FREE_MB 生效且 --min-free-mb 优先级最高", async () => {
  const dir = await makeInstalledDir({
    NOJ_VERSION: "v0.10.6",
    JUDGE_ENABLED: "false",
    NOJ_BACKUP_MIN_FREE_MB: "4096",
  });
  try {
    const lifecycleCalls: string[] = [];
    const runner: CommandRunner = {
      run(cmd, args) {
        if (cmd === "df") {
          // 可用 4.5 GiB（< 4096 MiB + 1536 MiB = 5.5 GiB，但 > 512 MiB + 1536 MiB = 2 GiB）
          return Promise.resolve({
            code: 0,
            stdout:
              "Filesystem 1024-blocks Used Available Capacity Mounted on\n" +
              `/dev/vda1 104857600 100139008 ${4608 * 1024} 95% /\n`,
            stderr: "",
          });
        }
        if (cmd === "docker" && args[0] === "info") {
          return Promise.resolve({
            code: 0,
            stdout: "/var/lib/docker\n",
            stderr: "",
          });
        }
        lifecycleCalls.push([cmd, ...args].join(" "));
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      spawn(): SpawnHandle {
        throw new Error("no spawn");
      },
    };

    // 1. 读 .env.prod 中的 4096 MiB：4 GiB + 1.5 GiB = 5.5 GiB > 4.5 GiB -> 拒绝且零 compose
    const envFileRes = await runProdUpdate(dir, [], {
      runner,
      processEnv: {},
      io: {
        write: () => {},
        readLine: () => Promise.resolve(""),
        readSecret: () => Promise.resolve(""),
      },
      isTty: () => false,
    });
    assertEquals(envFileRes.exitCode, 1);
    assertStringIncludes(envFileRes.error ?? "", "5.5 GiB");
    assertEquals(lifecycleCalls, []);

    // 2. 进程环境变量 3584 MiB (3.5 GiB) + 1.5 GiB = 5 GiB -> 覆盖 .env.prod 仍拒绝并反映 5 GiB
    const procEnvRes = await runProdUpdate(dir, [], {
      runner,
      processEnv: { NOJ_BACKUP_MIN_FREE_MB: "3584" },
      io: {
        write: () => {},
        readLine: () => Promise.resolve(""),
        readSecret: () => Promise.resolve(""),
      },
      isTty: () => false,
    });
    assertEquals(procEnvRes.exitCode, 1);
    assertStringIncludes(procEnvRes.error ?? "", "5 GiB");
    assertEquals(lifecycleCalls, []);

    // 3. --min-free-mb 512 覆盖上两层：512 MiB + 1.5 GiB = 2 GiB <= 4.5 GiB -> 越过空间预检进入后续流程
    const flagRes = await runProdUpdate(
      dir,
      ["--min-free-mb", String(512)],
      {
        runner,
        processEnv: { NOJ_BACKUP_MIN_FREE_MB: "3584" },
        fetcher: () =>
          Promise.resolve(new Response("not found", { status: 404 })),
        io: {
          write: () => {},
          readLine: () => Promise.resolve(""),
          readSecret: () => Promise.resolve(""),
        },
        isTty: () => false,
      },
    );
    assertEquals(
      flagRes.error?.includes("可用空间不足") ?? false,
      false,
      `--min-free-mb 512 应通过空间预检，实得错误：${flagRes.error}`,
    );
    assertStringIncludes(
      flagRes.error ?? "",
      "HTTP 404",
      "通过磁盘预检后应进入文件同步阶段",
    );
    void MIB;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
