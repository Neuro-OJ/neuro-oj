/**
 * 磁盘空间解析、数据量估算、同/异分区预检与告警阈值单测。
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { CommandRunner } from "../runtime/command.ts";
import {
  BACKUP_SAFETY_MARGIN_BYTES,
  calculateBackupRequiredBytes,
  type DiskPartitionInfo,
  estimateBackupDataSize,
  evaluateBackupDiskSpace,
  evaluateUpdateDiskSpace,
  formatDiskReportLines,
  GIB,
  MIB,
  parseDfPkOutput,
  parseMcDuBytes,
  parseNonNegativeIntBytes,
  parseRedisMemoryBytes,
  probeDiskUsageReport,
  UPDATE_IMAGE_PULL_BASE_BYTES,
  UPDATE_IMAGE_PULL_JUDGE_BYTES,
} from "./disk-space.ts";

function makePartition(
  overrides: Partial<DiskPartitionInfo> = {},
): DiskPartitionInfo {
  return {
    filesystem: "/dev/vda1",
    mountPoint: "/",
    totalBytes: 100 * GIB,
    usedBytes: 50 * GIB,
    availableBytes: 50 * GIB,
    usedPercent: 50,
    targetPath: "/opt/neuro-oj",
    probedPath: "/opt/neuro-oj",
    ...overrides,
  };
}

Deno.test("parseDfPkOutput: 解析 POSIX 1K 输出及含空格挂载点", () => {
  const linux = [
    "Filesystem     1024-blocks     Used Available Capacity Mounted on",
    "/dev/nvme0n1p1    41943040 10485760  31457280      25% /opt/my mount",
  ].join("\n");
  const parsed = parseDfPkOutput(
    linux,
    "/opt/my mount/backups",
    "/opt/my mount",
  );
  assert(parsed !== null);
  assertEquals(parsed.filesystem, "/dev/nvme0n1p1");
  assertEquals(parsed.mountPoint, "/opt/my mount");
  assertEquals(parsed.totalBytes, 41943040 * 1024);
  assertEquals(parsed.usedBytes, 10485760 * 1024);
  assertEquals(parsed.availableBytes, 31457280 * 1024);
  assertEquals(parsed.usedPercent, 25);

  assertEquals(parseDfPkOutput("", "/x"), null);
  assertEquals(parseDfPkOutput("Filesystem 1024-blocks\n", "/x"), null);
});

Deno.test("parseNonNegativeIntBytes / parseRedisMemoryBytes / parseMcDuBytes", () => {
  assertEquals(parseNonNegativeIntBytes("  1048576 \n"), 1048576);
  assertEquals(parseNonNegativeIntBytes("0"), 0);
  assertEquals(parseNonNegativeIntBytes("-5"), null);
  assertEquals(parseNonNegativeIntBytes("NaN"), null);

  const redisInfo =
    "# Memory\r\nused_memory:2097152\r\nused_memory_human:2.00M\r\n";
  assertEquals(parseRedisMemoryBytes(redisInfo), 2097152);
  assertEquals(parseRedisMemoryBytes("# empty\n"), null);

  // mc du --json
  const mcJson =
    '{"prefix":"noj-support-packages","size":536870912,"objects":12,"status":"success"}\n';
  assertEquals(parseMcDuBytes(mcJson), 536870912);
  // 人类可读文本回退
  assertEquals(parseMcDuBytes("2.5GiB   10 objects\n"), Math.ceil(2.5 * GIB));
  assertEquals(parseMcDuBytes(""), null);
});

Deno.test("calculateBackupRequiredBytes & evaluateBackupDiskSpace: 流式/非流式峰值与兜底下限", () => {
  const zero = calculateBackupRequiredBytes({
    rawDataBytes: 0,
    minFreeMb: 1024,
  });
  assertEquals(zero.requiredBytes, 1024 * MIB);

  const raw = 2 * GIB;
  const stream = calculateBackupRequiredBytes({
    rawDataBytes: raw,
    minFreeMb: 1024,
    streaming: true,
  });
  const legacy = calculateBackupRequiredBytes({
    rawDataBytes: raw,
    minFreeMb: 1024,
    streaming: false,
  });
  const expectedCompressed = Math.ceil(raw * 0.85);
  assertEquals(
    stream.requiredBytes,
    raw + expectedCompressed + BACKUP_SAFETY_MARGIN_BYTES,
  );
  assertEquals(
    legacy.requiredBytes,
    raw + expectedCompressed * 2 + BACKUP_SAFETY_MARGIN_BYTES,
  );
  assert(stream.requiredBytes < legacy.requiredBytes);

  const estimate = {
    postgresBytes: 512 * MIB,
    redisBytes: 128 * MIB,
    minioBytes: 1360 * MIB,
    totalBytes: 2000 * MIB,
    sources: ["PostgreSQL", "Redis", "MinIO"],
  };
  const smallFree = evaluateBackupDiskSpace({
    partition: makePartition({
      availableBytes: 2500 * MIB,
      mountPoint: "/data",
    }),
    minFreeMb: 1024,
    estimate,
    streaming: true,
  });
  assertEquals(smallFree.ok, false);
  assertStringIncludes(smallFree.error!, "可用空间不足");
  assertStringIncludes(smallFree.error!, "/data");
  assertStringIncludes(smallFree.error!, "需要");
  assertStringIncludes(smallFree.error!, "可用");
  assertStringIncludes(smallFree.error!, "PG ");
});

Deno.test("evaluateUpdateDiskSpace: 区分同分区叠加与异分区独立校验", () => {
  const estimate = {
    postgresBytes: 1 * GIB,
    redisBytes: 0,
    minioBytes: 1 * GIB,
    totalBytes: 2 * GIB,
    sources: ["PostgreSQL", "MinIO"],
  };
  // backupRequired = 2 GiB + ceil(2 GiB * 0.85) + 0.5 GiB = 4.2 GiB
  // judgeEnabled=false -> imagePullBytes = 1.5 GiB, total = 5.7 GiB
  const sameLow = evaluateUpdateDiskSpace({
    backupPartition: makePartition({ availableBytes: 5 * GIB }),
    dockerPartition: makePartition({ availableBytes: 5 * GIB }),
    minFreeMb: 1024,
    estimate,
    judgeEnabled: false,
    streaming: true,
  });
  assertEquals(sameLow.samePartition, true);
  assertEquals(sameLow.ok, false);
  assertEquals(sameLow.imagePullBytes, UPDATE_IMAGE_PULL_BASE_BYTES);
  assertStringIncludes(sameLow.error!, "需要");
  assertStringIncludes(sameLow.error!, "可用");

  const sameOk = evaluateUpdateDiskSpace({
    backupPartition: makePartition({ availableBytes: 7 * GIB }),
    dockerPartition: makePartition({ availableBytes: 7 * GIB }),
    minFreeMb: 1024,
    estimate,
    judgeEnabled: false,
    streaming: true,
  });
  assertEquals(sameOk.ok, true);

  // 异分区：备份足够(6 GiB) 但 Docker 分区不足(< 4 GiB with judge=true)
  const diffDockerShort = evaluateUpdateDiskSpace({
    backupPartition: makePartition({
      filesystem: "/dev/vdb1",
      mountPoint: "/opt/backups",
      availableBytes: 6 * GIB,
    }),
    dockerPartition: makePartition({
      filesystem: "/dev/vda1",
      mountPoint: "/var/lib/docker",
      availableBytes: 3 * GIB,
    }),
    minFreeMb: 1024,
    estimate,
    judgeEnabled: true,
    streaming: true,
  });
  assertEquals(diffDockerShort.samePartition, false);
  assertEquals(diffDockerShort.imagePullBytes, UPDATE_IMAGE_PULL_JUDGE_BYTES);
  assertEquals(diffDockerShort.ok, false);
  assertStringIncludes(diffDockerShort.error!, "/var/lib/docker");

  // 异分区：两者各自够用 -> 通过（即使各自小于合并总和）
  const diffBothOk = evaluateUpdateDiskSpace({
    backupPartition: makePartition({
      filesystem: "/dev/vdb1",
      mountPoint: "/opt/backups",
      availableBytes: 5 * GIB,
    }),
    dockerPartition: makePartition({
      filesystem: "/dev/vda1",
      mountPoint: "/var/lib/docker",
      availableBytes: 4.5 * GIB,
    }),
    minFreeMb: 1024,
    estimate,
    judgeEnabled: true,
    streaming: true,
  });
  assertEquals(diffBothOk.ok, true);
});

Deno.test("estimateBackupDataSize: 正常采集三源数据并在单个失败时降级继续", async () => {
  const runner: CommandRunner = {
    run(_cmd, args) {
      const joined = args.join(" ");
      if (joined.includes("pg_database_size")) {
        return Promise.resolve({ code: 0, stdout: "1073741824\n", stderr: "" });
      }
      if (joined.includes("INFO memory")) {
        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "redis down",
        });
      }
      if (joined.includes("mc du")) {
        return Promise.resolve({
          code: 0,
          stdout: '{"prefix":"b","size":536870912,"status":"success"}\n',
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn() {
      throw new Error("no spawn");
    },
  };
  const res = await estimateBackupDataSize({
    runner,
    compose: {
      composeFile: "/opt/noj/docker-compose.prod.yml",
      envFile: "/opt/noj/.env.prod",
      dockerBin: "docker",
    },
    env: { POSTGRES_USER: "noj", POSTGRES_DB: "noj", S3_BUCKET: "b" },
  });
  assertEquals(res.postgresBytes, 1 * GIB);
  assertEquals(res.redisBytes, null);
  assertEquals(res.minioBytes, 512 * MIB);
  assertEquals(res.totalBytes, 1 * GIB + 512 * MIB);
  assertEquals(res.sources, ["PostgreSQL", "MinIO"]);
});

Deno.test("probeDiskUsageReport: 同分区合并与异分区告警等级划分", async () => {
  const root = await Deno.makeTempDir();
  try {
    const installDir = join(root, "install");
    const dockerRoot = join(root, "docker-root");
    await Deno.mkdir(installDir, { recursive: true });
    await Deno.mkdir(dockerRoot, { recursive: true });
    let same = true;
    const runner: CommandRunner = {
      run(cmd, args) {
        if (cmd === "docker" && args[0] === "info") {
          return Promise.resolve({
            code: 0,
            stdout: `${dockerRoot}\n`,
            stderr: "",
          });
        }
        if (cmd === "df") {
          const target = args[args.length - 1] ?? "";
          if (same || target !== dockerRoot) {
            return Promise.resolve({
              code: 0,
              stdout:
                "Filesystem 1024-blocks Used Available Capacity Mounted on\n" +
                `/dev/vda1 104857600 94371840 ${3 * 1024 * 1024} 90% /\n`,
              stderr: "",
            });
          }
          return Promise.resolve({
            code: 0,
            stdout:
              "Filesystem 1024-blocks Used Available Capacity Mounted on\n" +
              `/dev/vdb1 104857600 10485760 ${
                90 * 1024 * 1024
              } 10% /var/lib/docker\n`,
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      spawn() {
        throw new Error("no spawn");
      },
    };

    const repSame = await probeDiskUsageReport({ runner, installDir });
    assert(repSame !== null);
    assertEquals(repSame.samePartition, true);
    assertEquals(repSame.entries.length, 1);
    assertEquals(repSame.entries[0]!.label, "安装目录 / Docker 数据目录");
    assertEquals(repSame.entries[0]!.status, "warning");
    assertStringIncludes(formatDiskReportLines(repSame)[0]!, "告警");

    same = false;
    const repDiff = await probeDiskUsageReport({ runner, installDir });
    assert(repDiff !== null);
    assertEquals(repDiff.samePartition, false);
    assertEquals(repDiff.entries.length, 2);
    assertEquals(repDiff.entries[0]!.status, "warning");
    assertEquals(repDiff.entries[1]!.status, "ok");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
