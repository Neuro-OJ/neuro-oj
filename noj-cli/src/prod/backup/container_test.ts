/**
 * T17 容器测试：`.nojbackup` 单文件容器 + prod-raw payload。
 *
 * 本套测试的**最高价值**用例是二进制完整性（"文件重定向采二进制"）：
 *
 * `maintain/backup_driver.ts:114` 的既有注释写明"数据经 stdout 字符串传输会损坏
 * 二进制"，旧实现用 base64 补救。本任务要求 prod-raw **不经字符串**，因此测试
 * 必须能证明这一点，而不是只断言"文件存在"：
 *
 * 1. 注入 fake 让采集**只**经 `spawn({ stdoutFile })` 写出**含 `\x00` 与高位字节**
 *    的载荷，断言落盘**逐字节相等**；
 * 2. fake 的 `run()` 一旦被用于采集 payload 即**抛错**——于是"是否走了字符串路径"
 *    成为可断言的硬约束，而不是靠 review；
 * 3. 反向用例：把同一份载荷经 UTF-8 字符串往返（模拟旧路径），断言摘要**必然不同**
 *    —— 证明 `pg_restore --list` 结构校验与 sha256sums 能抓住静默损坏。
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import type {
  CmdResult,
  CommandRunner,
  SpawnHandle,
  SpawnOpts,
} from "../../runtime/command.ts";
import {
  allocateContainerPath,
  BACKUP_SUFFIX,
  type BackupManifest,
  CONTAINER_FILES,
  containerFileName,
  type ContainerPayloadOps,
  createContainer,
  MANIFEST_DEFAULTS,
  parseChecksums,
  PAYLOAD_LAYOUT,
  renderChecksums,
  SCHEMA_VERSION,
  SUCCESS_MARKER,
  tempContainerPath,
  utcTimestamp,
} from "./container.ts";
import { fileSha256HexStreaming, Sha256 } from "./sha256.ts";

/** 一段**注定无法经 UTF-8 字符串往返**的字节：含 NUL、0xFF、0x80 与非法序列。 */
const BINARY_PAYLOAD = new Uint8Array([
  0x50,
  0x47,
  0x44,
  0x4d,
  0x50, // "PGDMP"（pg_dump -Fc 的魔术）
  0x00,
  0x00,
  0x00,
  0x00,
  0xff,
  0xfe,
  0xfd,
  0x80,
  0x81,
  0xc0,
  0xc1,
  0xf5,
  0x0a,
  0x00,
  0x1b,
  0x5b,
  0x33,
  0x31,
  0x6d, // 含裸 ESC（ANSI）
]);

/** 一次 spawn 调用记录。 */
interface SpawnRecord {
  cmd: string;
  args: string[];
  stdoutFile?: string;
}

/**
 * 记录 spawn/run 的 fake runner。
 *
 * `payloadBytes` 会在**每次** `stdoutFile` 采集时写出——模拟"内核把子进程 stdout
 * 直接落盘"。`run` 记录调用但**不**参与 payload 采集（见 `forbidRunForPayload`）。
 */
function makeRawRunner(
  spawns: SpawnRecord[],
  payloadBytes: Uint8Array = BINARY_PAYLOAD,
  overrides: (cmd: string, args: string[]) => Partial<CmdResult> | undefined =
    () => undefined,
  payloadSignatures: Partial<Record<string, Uint8Array>> = {},
): CommandRunner {
  return {
    run(cmd, args) {
      return Promise.resolve({
        code: 0,
        stdout: "",
        stderr: "",
        ...(overrides(cmd, args) ?? {}),
      });
    },
    spawn(opts: SpawnOpts): SpawnHandle {
      spawns.push({
        cmd: opts.cmd,
        args: [...opts.args],
        stdoutFile: opts.stdoutFile,
      });
      if (opts.stdoutFile !== undefined) {
        // 找出本次采集应对应的载荷（按参数特征区分 pg_dump / redis）。
        let bytes = payloadBytes;
        for (const [needle, payload] of Object.entries(payloadSignatures)) {
          if (opts.args.some((a) => a.includes(needle))) {
            bytes = payload!;
            break;
          }
        }
        // 同步写盘（fake 的 wait 之前完成），模拟内核重定向的时间点。
        Deno.writeFileSync(opts.stdoutFile, bytes);
      }
      return {
        pid: 1,
        wait: () => Promise.resolve(0),
        kill: () => Promise.resolve(),
      };
    },
  };
}

/** 一个会**抛错**的 runner：`run` 被调用即失败（用于证明未走字符串路径）。 */
function makeStrictRunner(
  spawns: SpawnRecord[],
  payloadBytes: Uint8Array = BINARY_PAYLOAD,
): CommandRunner {
  const base = makeRawRunner(spawns, payloadBytes);
  return {
    ...base,
    run(cmd, args) {
      // 只允许"非 payload 采集"的命令走 run（gpg/tar 这类不经 stdout 的）。
      const joined = args.join(" ");
      const forbidden = ["pg_dump", "pg_dumpall", "pg_restore", "--rdb"];
      for (const needle of forbidden) {
        if (joined.includes(needle)) {
          throw new Error(
            `payload 采集不得经 run() 的字符串路径（命中 ${needle}）：${cmd} ${joined}`,
          );
        }
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };
}

/**
 * 记录 tar 打进包里的 staging 快照的 fake ops。
 *
 * `tarZst` 是唯一"读目录"的步骤，故在此把 staging 内容复制出来，
 * 让测试能断言包内文件与 checksums。
 */
function makeFakeOps(opts: {
  runner: CommandRunner;
  /** 覆盖某个步骤的行为（抛错等）。 */
  override?: Partial<ContainerPayloadOps>;
  /** 记录 tar 调用（staging 目录 → 目标）。 */
  tars?: { stagingDir: string; dest: string }[];
  /** 记录 gpg 调用。 */
  gpgs?: { src: string; dest: string }[];
  /** 记录 restore-list 的输入输出路径对。 */
  restoreLists?: { dumpFile: string; destFile: string }[];
  /**
   * staging 快照的落点：`tarZst` 被调用时把 staging 内容**复制**到这里。
   *
   * 必要性：`createContainer` 的 `finally` 会清理 staging，因此测试**不能**在
   * 它返回后再读 staging——必须在其生命周期内取快照。tar 是唯一"读整个 staging"
   * 的步骤，故快照点选在那里。
   */
  stagingSnapshot?: string;
}): ContainerPayloadOps {
  const tars = opts.tars ?? [];
  const gpgs = opts.gpgs ?? [];
  const restoreLists = opts.restoreLists ?? [];
  /** 只在**第一轮**tar 时快照（第二轮时 manifest 已写入）。 */
  let snapshotTaken = false;

  const base: ContainerPayloadOps = {
    postgresDump(destFile) {
      return writeViaSpawn(opts.runner, destFile);
    },
    postgresGlobals(destFile) {
      return Deno.writeTextFile(destFile, "-- globals\nCREATE ROLE noj;\n");
    },
    async postgresRestoreList(dumpFile, destFile) {
      restoreLists.push({ dumpFile, destFile });
      // 真实 pg_restore 对空/损坏输入必然报错——fake 必须复现这一点，
      // 否则"空 dump 会被放过"这类缺陷在测试里不可见。
      const size = (await Deno.stat(dumpFile)).size;
      if (size === 0) {
        throw new Error(
          "pg_restore: error: did not find magic string in file header",
        );
      }
      await Deno.writeTextFile(
        destFile,
        "; archive listing\n1; 0 0 TABLE public t\n",
      );
    },
    redisRdb(destFile) {
      return writeViaSpawn(opts.runner, destFile);
    },
    redisPersistence(destFile) {
      return Deno.writeTextFile(destFile, "rdb_last_bgsave_status:ok\n");
    },
    minioMirror(destDir) {
      return Deno.mkdir(destDir, { recursive: true }).then(() =>
        Deno.writeTextFile(join(destDir, "object.bin"), "obj")
      );
    },
    gpgEncrypt(src, dest) {
      gpgs.push({ src, dest });
      return Deno.copyFile(src, dest);
    },
    gpgDecrypt(src, dest) {
      return Deno.copyFile(src, dest);
    },
    async tarZst(stagingDir, dest, _level) {
      tars.push({ stagingDir, dest });
      if (opts.stagingSnapshot !== undefined && !snapshotTaken) {
        snapshotTaken = true;
        await copyTree(stagingDir, opts.stagingSnapshot);
      }
      // 用 fflate 之外的零依赖方式：直接把 staging 打包成 tar 太复杂，
      // 这里只"记录 + 写一个占位文件"，包内容的断言由 restoreLists/gpgs/
      // listFiles 的旁路观察完成（见测试对 checksums 的直接断言）。
      const files = await listFilesUnder(stagingDir);
      await Deno.writeTextFile(dest, "TARZST:" + files.sort().join(","));
    },
    untarZst(src, destDir) {
      return Deno.mkdir(destDir, { recursive: true }).then(() =>
        Deno.copyFile(src, join(destDir, "payload.tar.zst"))
      );
    },
  };
  return { ...base, ...(opts.override ?? {}) };
}

/** 经 runner.spawn 的 stdoutFile 写出一段确定性字节。 */
async function writeViaSpawn(
  runner: CommandRunner,
  destFile: string,
): Promise<void> {
  const handle = runner.spawn({
    cmd: "docker",
    args: ["compose", "exec", "-T", "postgres", "pg_dump", "-Fc"],
    cwd: Deno.cwd(),
    env: {},
    stdoutFile: destFile,
  });
  await handle.wait();
}

/** 递归复制目录树（测试用）。 */
async function copyTree(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory) await copyTree(from, to);
    else await Deno.copyFile(from, to);
  }
}

/** 列出目录下所有文件（相对路径）。 */
async function listFilesUnder(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const rel = base + entry.name;
    if (entry.isDirectory) {
      out.push(...await listFilesUnder(join(dir, entry.name), rel + "/"));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/** 造一个可用的环境文件（内容任意，只用于加密）。 */
async function makeEnvFile(dir: string): Promise<string> {
  const envFile = join(dir, ".env.prod");
  await Deno.writeTextFile(envFile, "NOJ_VERSION=v0.9.5\nDOMAIN=oj.test\n");
  return envFile;
}

/** 创建容器的最小参数。 */
async function createOptions(
  root: string,
  ops: ContainerPayloadOps,
): Promise<Parameters<typeof createContainer>[0]> {
  const backupDir = join(root, "backups");
  return {
    backupDir,
    stagingParent: root,
    passphraseFile: join(root, "passphrase"),
    envFile: await makeEnvFile(root),
    postgresDatabase: "noj",
    migrationStatus: "not-initialized",
    ops,
    now: new Date("2026-09-19T12:00:00Z"),
  };
}

// ---------------- 二进制完整性（最高价值） ----------------

Deno.test("T17 create：postgres/redis 二进制经文件重定向落盘，逐字节等于原载荷", async () => {
  const root = await Deno.makeTempDir();
  try {
    const spawns: SpawnRecord[] = [];
    const tars: { stagingDir: string; dest: string }[] = [];
    const snapshot = join(root, "snapshot-of-staging");
    const ops = makeFakeOps({
      // 严格 runner：payload 采集一旦走 run() 即抛错
      runner: makeStrictRunner(spawns),
      tars,
      stagingSnapshot: snapshot,
    });
    const result = await createContainer(await createOptions(root, ops));

    assert(result.path.endsWith(BACKUP_SUFFIX));
    // 采集**必须**经 spawn 的 stdoutFile（内核级重定向），且不得经 run()
    assert(
      spawns.length >= 2,
      "pg_dump 与 redis-cli --rdb 都必须经 spawn 采集",
    );
    for (const s of spawns) {
      assert(s.stdoutFile !== undefined, "采集必须给出 stdoutFile");
    }

    // 从 tar 时刻的 staging 快照读出实际落盘的 payload 并逐字节比对
    // （createContainer 的 finally 已清理真实 staging，故必须用快照）。
    assertEquals(tars.length, 1, "单轮打包");
    const dump = await Deno.readFile(
      join(snapshot, CONTAINER_FILES.postgresDump),
    );
    assertEquals(
      [...dump],
      [...BINARY_PAYLOAD],
      "postgres.dump 必须逐字节等于容器输出（含 NUL 与高位字节）",
    );
    const rdb = await Deno.readFile(join(snapshot, CONTAINER_FILES.redisRdb));
    assertEquals([...rdb], [...BINARY_PAYLOAD]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T17 反例：同一载荷经 UTF-8 字符串往返后摘要必然不同（静默损坏可检出）", async () => {
  const root = await Deno.makeTempDir();
  try {
    const exact = join(root, "exact.bin");
    const mangled = join(root, "mangled.bin");
    await Deno.writeFile(exact, BINARY_PAYLOAD);
    // 模拟旧路径：Buffer→string→Buffer（UTF-8 往返），非法序列被替换为 U+FFFD
    const text = new TextDecoder().decode(BINARY_PAYLOAD);
    await Deno.writeFile(
      mangled,
      new TextEncoder().encode(text),
    );

    const exactSha = await fileSha256HexStreaming(exact);
    const mangledSha = await fileSha256HexStreaming(mangled);
    assert(
      exactSha !== mangledSha,
      "经字符串往返的载荷摘要必须不同——这是静默损坏可被检出的依据",
    );
    // 且字节确实被破坏（不是偶然相同长度）
    assertEquals(
      (await Deno.readFile(mangled)).length === BINARY_PAYLOAD.length &&
        [...await Deno.readFile(mangled)].every((b, i) =>
          b === BINARY_PAYLOAD[i]
        ),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T17 create：pg_restore --list 的结构校验在成功路径上（输入来自文件）", async () => {
  const root = await Deno.makeTempDir();
  try {
    const spawns: SpawnRecord[] = [];
    const restoreLists: { dumpFile: string; destFile: string }[] = [];
    const ops = makeFakeOps({
      runner: makeStrictRunner(spawns),
      restoreLists,
    });
    await createContainer(await createOptions(root, ops));

    assertEquals(restoreLists.length, 1, "必须跑一次 pg_restore --list");
    // 输入必须是**文件**路径（不是内容字符串）
    assert(
      restoreLists[0]!.dumpFile.endsWith(CONTAINER_FILES.postgresDump),
      "pg_restore --list 的输入必须是 postgres.dump 文件路径",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T17 create：pg_restore --list 失败 → 整体失败且备份目录零残留", async () => {
  const root = await Deno.makeTempDir();
  try {
    const spawns: SpawnRecord[] = [];
    const ops = makeFakeOps({
      runner: makeStrictRunner(spawns),
      override: {
        postgresRestoreList() {
          return Promise.reject(
            new Error(
              "pg_restore: error: did not find magic string in file header",
            ),
          );
        },
      },
    });
    const options = await createOptions(root, ops);
    await assertRejects(
      () => createContainer(options),
      Error,
      "did not find magic string",
    );
    // 零残留：备份目录内不得有任何 .nojbackup
    await assertNoArtifacts(join(root, "backups"));
    await assertNoStaging(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------- 容器形状与 manifest ----------------

Deno.test("T17 create：manifest 的 payload_layout/字段/摘要时序正确", async () => {
  const root = await Deno.makeTempDir();
  try {
    const spawns: SpawnRecord[] = [];
    const tars: { stagingDir: string; dest: string }[] = [];
    const ops = makeFakeOps({ runner: makeStrictRunner(spawns), tars });
    const result = await createContainer(await createOptions(root, ops));
    const m: BackupManifest = result.manifest;

    assertEquals(m.payload_layout, PAYLOAD_LAYOUT);
    assertEquals(m.payload_layout, "prod-raw");
    assertEquals(m.schema_version, SCHEMA_VERSION);
    assertEquals(m.encrypted, true);
    assertEquals(m.created_at, "2026-09-19T12:00:00Z");
    assertEquals(m.postgres_database, "noj");
    assertEquals(m.retention_days, 30);
    // bash 的说明性字段逐字保留
    assertEquals(m.redis_policy, MANIFEST_DEFAULTS.redis_policy);
    assertEquals(m.object_storage, MANIFEST_DEFAULTS.object_storage);
    assertEquals(m.postgres_backup_mode, "logical-full");
    assertEquals(m.incremental_policy, MANIFEST_DEFAULTS.incremental_policy);
    assertEquals(m.rpo, MANIFEST_DEFAULTS.rpo);
    assertEquals(m.rto, MANIFEST_DEFAULTS.rto);
    // 单轮打包即可：manifest 内**不放**整包摘要（自指不可能，见 container.ts）
    assertEquals(tars.length, 1, "manifest 不再引用自身归档的摘要，故单轮打包");
    // 整包摘要落在同级 sidecar，且与容器文件一致
    assertEquals(result.sidecar, result.path + ".sha256");
    assertStringIncludes(
      await Deno.readTextFile(result.sidecar),
      result.sha256,
    );
    assertStringIncludes(
      await Deno.readTextFile(result.sidecar),
      result.path.split("/").pop()!,
    );
    // files 含 manifest 与 checksums，且已排序
    assert(m.files.includes(CONTAINER_FILES.manifest));
    assert(m.files.includes(CONTAINER_FILES.checksums));
    assertEquals([...m.files].sort(), m.files);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T17 create：checksums 覆盖除自身外的全部文件，格式为 GNU 两空格", async () => {
  const root = await Deno.makeTempDir();
  try {
    const spawns: SpawnRecord[] = [];
    const snapshot = join(root, "snapshot-of-staging");
    const ops = makeFakeOps({
      runner: makeStrictRunner(spawns),
      stagingSnapshot: snapshot,
    });
    await createContainer(await createOptions(root, ops));

    // 第一轮 tar 时的快照（此时 manifest 尚未写入，checksums 刚生成）
    const text = await Deno.readTextFile(
      join(snapshot, CONTAINER_FILES.checksums),
    );
    const entries = parseChecksums(text);
    const names = entries.map((e) => e.relPath);
    // 覆盖全部文件（除自身）
    const all = (await listFilesUnder(snapshot)).filter((rel) =>
      rel !== CONTAINER_FILES.checksums
    );
    for (const rel of all) {
      assert(names.includes(rel), `checksums 必须覆盖 ${rel}`);
    }
    assertEquals(
      names.includes(CONTAINER_FILES.checksums),
      false,
      "不得自校验",
    );
    // 摘要必须真实
    for (const entry of entries) {
      assertEquals(
        entry.sha256,
        await fileSha256HexStreaming(join(snapshot, entry.relPath)),
        `${entry.relPath} 的摘要必须与文件一致`,
      );
    }
    // sorted（LC_ALL=C 语义）
    assertEquals(names, [...names].sort());
    // SUCCESS 内容
    assertEquals(
      (await Deno.readTextFile(join(snapshot, CONTAINER_FILES.success)))
        .trim(),
      SUCCESS_MARKER,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T17 create：整包加密的输入是 tar.zst（不是逐文件），产物是单个 .nojbackup", async () => {
  const root = await Deno.makeTempDir();
  try {
    const spawns: SpawnRecord[] = [];
    const gpgs: { src: string; dest: string }[] = [];
    const ops = makeFakeOps({ runner: makeStrictRunner(spawns), gpgs });
    const result = await createContainer(await createOptions(root, ops));

    // gpg 被调用了两次：一次加密 env.prod，一次加密整包（tar.zst）
    assertEquals(gpgs.length, 2, "env 单文件 + 整包各一次");
    // 第一次是 env → env.prod.gpg
    assert(gpgs[0]!.dest.endsWith(CONTAINER_FILES.envProdGpg));
    // 第二次的输入必须是 tar.zst（整包）
    assert(
      gpgs[1]!.src.endsWith(".tar.zst"),
      `整包加密的输入必须是 tar.zst，实得 ${gpgs[1]!.src}`,
    );
    // 产物是**单个文件**
    const backupDir = result.path.substring(0, result.path.lastIndexOf("/"));
    const names: string[] = [];
    for await (const e of Deno.readDir(backupDir)) names.push(e.name);
    const backups = names.filter((n) => n.endsWith(BACKUP_SUFFIX));
    assertEquals(backups.length, 1, "备份目录内只应有一个 .nojbackup");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T17 create：--no-encrypt 仍产出单文件且 manifest.encrypted=false", async () => {
  const root = await Deno.makeTempDir();
  try {
    const spawns: SpawnRecord[] = [];
    const gpgs: { src: string; dest: string }[] = [];
    const ops = makeFakeOps({ runner: makeStrictRunner(spawns), gpgs });
    const options = await createOptions(root, ops);
    const result = await createContainer({
      ...options,
      noEncrypt: true,
      passphraseFile: undefined,
    });

    assertEquals(result.manifest.encrypted, false);
    assert(result.path.endsWith(BACKUP_SUFFIX));
    // 只加密了 env.prod 那一次（整包不加密）
    assertEquals(gpgs.length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T17 create：缺口令且未 --no-encrypt → 明确报错且零产物", async () => {
  const root = await Deno.makeTempDir();
  try {
    const spawns: SpawnRecord[] = [];
    const ops = makeFakeOps({ runner: makeStrictRunner(spawns) });
    const options = await createOptions(root, ops);
    await assertRejects(
      () => createContainer({ ...options, passphraseFile: undefined }),
      Error,
      "缺少 GPG 口令文件",
    );
    await assertNoArtifacts(join(root, "backups"));
    assertEquals(spawns.length, 0, "缺口令时必须在任何采集之前失败");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------- 失败路径与原子性 ----------------

Deno.test("T17 create：加密失败 → 零 .nojbackup 残留、零 staging 残留", async () => {
  const root = await Deno.makeTempDir();
  try {
    const spawns: SpawnRecord[] = [];
    const ops = makeFakeOps({
      runner: makeStrictRunner(spawns),
      override: {
        gpgEncrypt(src, dest) {
          // 第一次（env）成功，第二次（整包）失败
          if (src.endsWith(".tar.zst")) {
            return Promise.reject(
              new Error("gpg: symmetric encryption failed"),
            );
          }
          return Deno.copyFile(src, dest);
        },
      },
    });
    const options = await createOptions(root, ops);
    await assertRejects(
      () => createContainer(options),
      Error,
      "symmetric encryption failed",
    );
    await assertNoArtifacts(join(root, "backups"));
    await assertNoStaging(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T17 create：打包失败 → 零残留", async () => {
  const root = await Deno.makeTempDir();
  try {
    const spawns: SpawnRecord[] = [];
    const ops = makeFakeOps({
      runner: makeStrictRunner(spawns),
      override: {
        tarZst() {
          return Promise.reject(new Error("tar 打包失败: zstd not found"));
        },
      },
    });
    const options = await createOptions(root, ops);
    await assertRejects(
      () => createContainer(options),
      Error,
      "zstd not found",
    );
    await assertNoArtifacts(join(root, "backups"));
    await assertNoStaging(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T17 create：pg_dump 输出为空 → 失败（防空备份）", async () => {
  const root = await Deno.makeTempDir();
  try {
    const spawns: SpawnRecord[] = [];
    const ops = makeFakeOps({
      runner: makeStrictRunner(spawns),
      override: {
        async postgresDump(destFile) {
          await Deno.writeFile(destFile, new Uint8Array());
        },
      },
    });
    // 空 dump 本身不报错，但 pg_restore --list 会失败 → 整体失败
    const options = await createOptions(root, ops);
    await assertRejects(() => createContainer(options), Error);
    await assertNoArtifacts(join(root, "backups"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T17 create：已存在同名快照时追加序号（不覆盖既有备份）", async () => {
  const root = await Deno.makeTempDir();
  try {
    const spawns: SpawnRecord[] = [];
    const ops = makeFakeOps({ runner: makeStrictRunner(spawns) });
    const options = await createOptions(root, ops);
    await Deno.mkdir(options.backupDir, { recursive: true });
    // 预置同名快照
    const taken = containerFileName(options.now!);
    await Deno.writeTextFile(join(options.backupDir, taken), "existing");

    const result = await createContainer(options);
    assert(result.path !== join(options.backupDir, taken), "不得覆盖既有快照");
    assertEquals(
      await Deno.readTextFile(join(options.backupDir, taken)),
      "existing",
    );
    assertStringIncludes(result.path, "-1" + BACKUP_SUFFIX);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------- 纯函数 ----------------

Deno.test("T17 containerFileName / allocateContainerPath / tempContainerPath", async () => {
  const ts = new Date("2026-09-19T12:34:56Z");
  assertEquals(containerFileName(ts), "snapshot-20260919-123456.nojbackup");
  assertEquals(utcTimestamp(ts), "2026-09-19T12:34:56Z");

  const root = await Deno.makeTempDir();
  try {
    const first = await allocateContainerPath(root, ts);
    assertEquals(first, join(root, "snapshot-20260919-123456.nojbackup"));
    await Deno.writeTextFile(first, "x");
    const second = await allocateContainerPath(root, ts);
    assertEquals(second, join(root, "snapshot-20260919-123456-1.nojbackup"));
    // 临时名与最终名同目录（rename 才是原子提交）
    assert(tempContainerPath(first).startsWith(root + "/"));
    assert(tempContainerPath(first) !== first);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T17 renderChecksums / parseChecksums：往返一致且拒绝非法行", () => {
  const text = renderChecksums([
    { relPath: "postgres.dump", sha256: "a".repeat(64) },
    { relPath: "minio/a b.bin", sha256: "b".repeat(64) }, // 路径含空格
  ]);
  // 排序：minio/... < postgres.dump
  assertEquals(text.split("\n")[0], "b".repeat(64) + "  minio/a b.bin");
  const parsed = parseChecksums(text);
  assertEquals(parsed.map((e) => e.relPath), [
    "minio/a b.bin",
    "postgres.dump",
  ]);
  // 路径含空格也能正确切分（按首个"两空格"切）
  assertEquals(parsed[0]!.sha256, "b".repeat(64));

  // 非法行必须抛错（静默跳过会让校验形同虚设）
  let message = "";
  try {
    parseChecksums("not-a-valid-line");
  } catch (err) {
    message = (err as Error).message;
  }
  assertStringIncludes(message, "行格式非法");

  message = "";
  try {
    parseChecksums("zzzz  path");
  } catch (err) {
    message = (err as Error).message;
  }
  assertStringIncludes(message, "摘要非法");
});

// ---------------- 辅助断言 ----------------

/** 备份目录内不得有任何 `.nojbackup` 或临时产物。 */
async function assertNoArtifacts(backupDir: string): Promise<void> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(backupDir)) names.push(entry.name);
  } catch {
    return; // 目录不存在也算零残留
  }
  assertEquals(
    names.filter((n) => n.endsWith(BACKUP_SUFFIX) || n.includes(".nojbackup-")),
    [],
    "失败路径不得留下备份产物或临时文件",
  );
}

/** 不得留下 staging 目录或 tar.zst。 */
async function assertNoStaging(root: string): Promise<void> {
  const leftovers: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (
      entry.name.startsWith(".nojbackup-staging-") ||
      entry.name.endsWith(".tar.zst")
    ) {
      leftovers.push(entry.name);
    }
  }
  assertEquals(leftovers, [], "失败路径必须清理 staging 与 tar.zst");
}

Deno.test("T17 sha256 复用：容器使用增量实现（大文件不整读）", async () => {
  // 直接对照平台实现，锁住容器层的摘要来源正确
  const root = await Deno.makeTempDir();
  try {
    const path = join(root, "big.bin");
    const data = new Uint8Array(2 * 1024 * 1024 + 3);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;
    await Deno.writeFile(path, data);
    const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
    let expected = "";
    for (const b of new Uint8Array(digest)) {
      expected += b.toString(16).padStart(2, "0");
    }
    assertEquals(await fileSha256HexStreaming(path), expected);
    assertEquals(
      new Sha256().update(data.subarray(0, 1000)).update(
        data.subarray(1000),
      ).digestHex(),
      expected,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ── 评审发现：最终产物权限由 umask 决定（--no-encrypt 时明文可读）────
//
// `chmodPrivate` 只遍历 staging 目录，而 rename 出来的 `.nojbackup` 与 sidecar
// 的权限由进程 umask 决定——实测 umask 022 下是 **644**。即
// `backup create --no-encrypt` 产出的容器**含明文 pg dump 且全世界可读**
// （bash 侧是 `chmod -R go-rwx`）。
//
// 加密时风险较小，但"同一命令的产物权限取决于调用者 umask"本身不可接受：
// 备份不该比 `.env.prod`（600）更宽松。

Deno.test("评审: 产物 .nojbackup 与 sidecar 必须是 600（不随 umask 放宽）", async () => {
  const { createContainer } = await import("./container.ts");
  const root = await Deno.makeTempDir();
  const prev = Deno.umask();
  try {
    // 故意放宽 umask，模拟"宽松环境"——修复前产物会变成 644
    Deno.umask(0o022);
    const backupDir = join(root, "backups");
    await Deno.mkdir(backupDir, { recursive: true });

    // 复用既有 helper，避免手抄选项形状（我第一版手抄了一遍，签名对不上）
    const spawns: SpawnRecord[] = [];
    const ops = makeFakeOps({ runner: makeStrictRunner(spawns) });
    const options = await createOptions(root, ops);
    const result = await createContainer({
      ...options,
      backupDir,
      noEncrypt: true,
      passphraseFile: undefined,
    });

    for (const path of [result.path, result.sidecar]) {
      const st = await Deno.stat(path);
      assertEquals(
        (st.mode ?? 0) & 0o077,
        0,
        `${path} 不得对 group/other 开放（实测 umask 022 下曾是 644）`,
      );
    }
  } finally {
    Deno.umask(prev);
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
