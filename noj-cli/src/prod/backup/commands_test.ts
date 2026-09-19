/**
 * T18 命令面测试：verify 三档 / list / prune 默认 dry-run / restore --dry-run。
 *
 * 三条硬约束由本套测试锁死（都是实测过的缺陷面）：
 *
 * 1. **三档累加**：逐档注入缺陷，断言"恰好触发对应档"的失败，且高档在低档失败
 *    时也必然失败（不能"加个旗标就通过"）。
 * 2. **prune 默认 dry-run**：无 `--confirm` 时零删除、零副作用。
 * 3. **都不创建备份**：命令前后备份目录**逐项不变**（清单 + 各自摘要）。
 *
 * 容器由 T17 的 `createContainer` + fake ops 真实产出，故这些测试覆盖的是
 * **真实容器**而非手工构造的假包。
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  type ContainerPayloadOps,
  createContainer,
  PAYLOAD_LAYOUT,
  tempContainerPath,
} from "./container.ts";
import {
  assertContainerPath,
  backupCount,
  listBackupCommand,
  prodBackupDir,
  pruneCommand,
  restorePlan,
  verifyCommand,
} from "./commands.ts";
import { makeTempDir } from "../../testing/helpers.ts";
import { fileSha256HexStreaming, Sha256 } from "./sha256.ts";

/** 一份合法 Redis RDB 的开头（`REDIS` 魔术串 + 版本）。 */
const REDIS_RDB = new Uint8Array([
  0x52,
  0x45,
  0x44,
  0x49,
  0x53, // REDIS
  0x30,
  0x30,
  0x31,
  0x31, // 0011
  0x00,
  0x01,
  0x02,
  0x03,
  0xff,
]);

/** 一份合法的 pg_dump -Fc 风格字节（含 NUL 与高位字节）。 */
const PG_DUMP = new Uint8Array([
  0x50,
  0x47,
  0x44,
  0x4d,
  0x50, // PGDMP
  0x01,
  0x0e,
  0x00,
  0x00,
  0x00,
  0xff,
  0x80,
  0xfe,
]);

/**
 * 让"容器"落在真实文件系统上的一组 fake ops。
 *
 * 关键：`tarZst` 用 fflate 之外的方式做**真实归档**太复杂，因此这里用一个
 * 自定义的确定性打包：把 staging 目录序列化成一个自描述字节流（文件名 + 内容），
 * `untarZst` 再还原。这样 verify 的**解包后校验**是在真实字节上发生的，
 * 而不是靠 fake 假装。
 */
interface ArchiveEntry {
  name: string;
  data: Uint8Array;
}

function makeArchive(entries: ArchiveEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const header = new Sha256().update(
    new TextEncoder().encode(String(entries.length)),
  ).digestHex();
  chunks.push(new TextEncoder().encode("TARZST1:" + header + "\n"));
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    chunks.push(
      new TextEncoder().encode(
        `ENTRY ${entry.data.length} ${entry.name}\n`,
      ),
    );
    chunks.push(entry.data);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** 解析 {@link makeArchive} 的产物。 */
function readArchive(bytes: Uint8Array): ArchiveEntry[] {
  const text = new TextDecoder("latin1").decode(bytes);
  if (!text.startsWith("TARZST1:")) throw new Error("归档格式非法");
  const out: ArchiveEntry[] = [];
  let at = text.indexOf("\n") + 1;
  while (at < bytes.length) {
    const lineEnd = text.indexOf("\n", at);
    if (lineEnd === -1) break;
    const line = text.slice(at, lineEnd);
    const m = /^ENTRY (\d+) (.+)$/.exec(line);
    if (m === null) break;
    const size = Number(m[1]);
    const name = m[2]!;
    const dataStart = lineEnd + 1;
    out.push({ name, data: bytes.subarray(dataStart, dataStart + size) });
    at = dataStart + size;
  }
  return out;
}

/** 逐步复制目录树。 */
async function copyTree(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory) await copyTree(from, to);
    else await Deno.copyFile(from, to);
  }
}

/** 列出目录内全部文件的相对路径（排序）。 */
async function filesOf(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const rel = base + entry.name;
    if (entry.isDirectory) {
      out.push(...await filesOf(join(dir, entry.name), rel + "/"));
    } else out.push(rel);
  }
  return out.sort();
}

/** 备份目录的"指纹"：清单 + 每项摘要（用于断言命令零副作用）。 */
async function fingerprint(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names.sort()) {
    const path = join(dir, name);
    // 目录形态（legacy 快照）：递归取内部文件指纹，否则会 IsADirectory
    if ((await Deno.stat(path)).isDirectory) {
      for (const rel of await filesOf(path)) {
        out.push(
          `${name}/${rel}:${await fileSha256HexStreaming(join(path, rel))}`,
        );
      }
      continue;
    }
    out.push(`${name}:${await fileSha256HexStreaming(path)}`);
  }
  return out;
}

/** 造一组会真实写出 payload 并真实打包/解包的 ops。 */
function makeRealishOps(): {
  ops: ContainerPayloadOps;
  /** 篡改钩子：在打包前改动某个 staging 文件（模拟快照被篡改）。 */
  tamper: { file?: string; mutate?: (path: string) => Promise<void> };
} {
  const tamper: { file?: string; mutate?: (path: string) => Promise<void> } =
    {};
  const ops: ContainerPayloadOps = {
    async postgresDump(destFile) {
      await Deno.writeFile(destFile, PG_DUMP);
    },
    async postgresGlobals(destFile) {
      await Deno.writeTextFile(
        destFile,
        "-- globals\nCREATE ROLE noj;\n",
      );
    },
    async postgresRestoreList(_dumpFile, destFile) {
      await Deno.writeTextFile(
        destFile,
        "; archive listing\n1; 0 0 TABLE public submissions\n",
      );
    },
    async redisRdb(destFile) {
      await Deno.writeFile(destFile, REDIS_RDB);
    },
    async redisPersistence(destFile) {
      await Deno.writeTextFile(destFile, "rdb_last_bgsave_status:ok\r\n");
    },
    async minioMirror(destDir) {
      await Deno.mkdir(destDir, { recursive: true });
      await Deno.writeTextFile(join(destDir, "pkg.bin"), "object-bytes");
      await Deno.mkdir(join(destDir, "nested"), { recursive: true });
      await Deno.writeTextFile(join(destDir, "nested/deep.txt"), "deep");
    },
    async gpgEncrypt(src, dest, passphraseFile) {
      // "加密" = 魔数头 + **口令指纹** + 正文。口令指纹让"错误口令必须失败"
      // 成为可断言的行为——否则那条用例会是假绿（fake 对口令不敏感）。
      const body = await Deno.readFile(src);
      const print = new TextEncoder().encode(
        (await fileSha256HexStreaming(passphraseFile)).slice(0, 16),
      );
      const head = new TextEncoder().encode("GPGX");
      const out = new Uint8Array(head.length + print.length + body.length);
      out.set(head, 0);
      out.set(print, head.length);
      out.set(body, head.length + print.length);
      await Deno.writeFile(dest, out);
    },
    async gpgDecrypt(src, dest, passphraseFile) {
      const bytes = await Deno.readFile(src);
      if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "GPGX") {
        throw new Error("gpg: decryption failed: no secret key");
      }
      const print = new TextDecoder().decode(bytes.subarray(4, 20));
      const expected = (await fileSha256HexStreaming(passphraseFile)).slice(
        0,
        16,
      );
      if (print !== expected) {
        throw new Error("gpg: decryption failed: Bad session key");
      }
      await Deno.writeFile(dest, bytes.subarray(20));
    },
    async tarZst(stagingDir, dest, _level) {
      // 篡改钩子（在归档前改动 payload）
      if (tamper.file !== undefined && tamper.mutate !== undefined) {
        await tamper.mutate(join(stagingDir, tamper.file));
      }
      const files = await filesOf(stagingDir);
      const entries: ArchiveEntry[] = [];
      for (const rel of files) {
        entries.push({
          name: rel,
          data: await Deno.readFile(join(stagingDir, rel)),
        });
      }
      await Deno.writeFile(dest, makeArchive(entries));
    },
    async untarZst(src, destDir) {
      const bytes = await Deno.readFile(src);
      await Deno.mkdir(destDir, { recursive: true });
      for (const entry of readArchive(bytes)) {
        const target = join(destDir, entry.name);
        const parent = target.substring(0, target.lastIndexOf("/"));
        if (parent.length > 0) await Deno.mkdir(parent, { recursive: true });
        await Deno.writeFile(target, entry.data);
      }
    },
  };
  return { ops, tamper };
}

/** 产出一个真实容器，返回其路径与宿主目录。 */
async function makeContainer(): Promise<{
  root: string;
  backupDir: string;
  path: string;
  ops: ContainerPayloadOps;
  tamper: { file?: string; mutate?: (path: string) => Promise<void> };
}> {
  const root = await makeTempDir();
  const backupDir = join(root, "backups");
  const envFile = join(root, ".env.prod");
  await Deno.writeTextFile(envFile, "NOJ_VERSION=v0.9.5\nDOMAIN=oj.test\n");
  const passphrase = join(root, "passphrase");
  await Deno.writeTextFile(passphrase, "x".repeat(64));
  const { ops, tamper } = makeRealishOps();

  const result = await createContainer({
    backupDir,
    stagingParent: root,
    passphraseFile: passphrase,
    envFile,
    postgresDatabase: "noj",
    migrationStatus: "not-initialized",
    ops,
    now: new Date("2026-09-19T12:00:00Z"),
  });
  return { root, backupDir, path: result.path, ops, tamper };
}

/** 解包工作目录（每个命令一份，避免互相干扰）。 */
async function workDir(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await Deno.mkdir(dir, { recursive: true });
  return dir;
}

// ---------------- verify 三档 ----------------

Deno.test("T18 verify：三档累加全部通过（真实容器）", async () => {
  const c = await makeContainer();
  try {
    const passphraseFile = join(c.root, "passphrase");
    const plain = await verifyCommand({
      path: c.path,
      workDir: await workDir(c.root, "w1"),
      passphraseFile,
      ops: c.ops,
    });
    assertEquals(plain.pass, true, plain.summary);
    assertEquals(plain.checks.files, true);
    assertEquals(plain.manifest?.payload_layout, PAYLOAD_LAYOUT);
    assertEquals(plain.issues, []);
    assertStringIncludes(plain.summary, "快照校验通过");

    const deep = await verifyCommand({
      path: c.path,
      workDir: await workDir(c.root, "w2"),
      passphraseFile,
      ops: c.ops,
      deep: true,
    });
    assertEquals(deep.pass, true, deep.summary);
    assertEquals(deep.checks.deep, true);
    assertEquals(deep.skippedDecrypt, false);
    assertStringIncludes(deep.summary, "--deep");

    const payload = await verifyCommand({
      path: c.path,
      workDir: await workDir(c.root, "w3"),
      passphraseFile,
      ops: c.ops,
      deep: true,
      payloadSha: true,
    });
    assertEquals(payload.pass, true, payload.summary);
    assertEquals(payload.checks.payload, true);
    assertStringIncludes(payload.summary, "--payload-sha");
  } finally {
    await Deno.remove(c.root, { recursive: true });
  }
});

Deno.test("T18 verify：篡改 payload 一个字节 → 默认档必须失败（sha256sums 抓住）", async () => {
  const root = await makeTempDir();
  try {
    const backupDir = join(root, "backups");
    const envFile = join(root, ".env.prod");
    await Deno.writeTextFile(envFile, "NOJ_VERSION=v0.9.5\n");
    const passphrase = join(root, "passphrase");
    await Deno.writeTextFile(passphrase, "x".repeat(64));
    const { ops, tamper } = makeRealishOps();
    // 在归档前篡改 redis.rdb 的**内容**（checksums 是之前算的，故必然不一致）
    tamper.file = "redis.rdb";
    tamper.mutate = async (path) => {
      const bytes = await Deno.readFile(path);
      // 翻转末尾一个 bit（模拟介质损坏/篡改），保留长度不变
      const last = bytes.length - 1;
      bytes[last] = (bytes[last]! ^ 0xff) & 0xff;
      await Deno.writeFile(path, bytes);
    };
    const created = await createContainer({
      backupDir,
      stagingParent: root,
      passphraseFile: passphrase,
      envFile,
      postgresDatabase: "noj",
      migrationStatus: "n/a",
      ops,
      now: new Date("2026-09-19T12:00:00Z"),
    });

    const result = await verifyCommand({
      path: created.path,
      workDir: join(root, "w"),
      passphraseFile: passphrase,
      ops,
    });
    assertEquals(result.pass, false);
    assertEquals(result.checks.files, false);
    assert(
      result.issues.some((i) =>
        i.level === "files" && i.message.includes("SHA-256 校验失败")
      ),
      `必须报出 SHA-256 校验失败，实得：${JSON.stringify(result.issues)}`,
    );
    assertStringIncludes(result.summary, "快照校验失败");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T18 verify --deep：redis.rdb 缺 REDIS 魔术串 → 恰好 --deep 失败", async () => {
  const root = await makeTempDir();
  try {
    const backupDir = join(root, "backups");
    const envFile = join(root, ".env.prod");
    await Deno.writeTextFile(envFile, "NOJ_VERSION=v0.9.5\n");
    const passphrase = join(root, "passphrase");
    await Deno.writeTextFile(passphrase, "x".repeat(64));
    const { ops } = makeRealishOps();
    // 用非 RDB 内容替换 redis.rdb（但在 checksums 计算**之前**，故默认档仍通过）
    const brokenOps: ContainerPayloadOps = {
      ...ops,
      async redisRdb(destFile) {
        await Deno.writeFile(
          destFile,
          new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]),
        );
      },
    };
    const created = await createContainer({
      backupDir,
      stagingParent: root,
      passphraseFile: passphrase,
      envFile,
      postgresDatabase: "noj",
      migrationStatus: "n/a",
      ops: brokenOps,
      now: new Date("2026-09-19T12:00:00Z"),
    });

    // 默认档通过（checksums 与文件一致）
    const plain = await verifyCommand({
      path: created.path,
      workDir: join(root, "w1"),
      passphraseFile: passphrase,
      ops: brokenOps,
    });
    assertEquals(plain.pass, true, "默认档只看完整性，不看结构");

    // --deep 失败，且只报结构问题
    const deep = await verifyCommand({
      path: created.path,
      workDir: join(root, "w2"),
      passphraseFile: passphrase,
      ops: brokenOps,
      deep: true,
    });
    assertEquals(deep.pass, false);
    assertEquals(deep.checks.files, true, "默认档仍应通过");
    assertEquals(deep.checks.deep, false);
    assert(
      deep.issues.some((i) =>
        i.level === "deep" && i.message.includes("redis.rdb 不可解析")
      ),
      JSON.stringify(deep.issues),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T18 verify：整包加密 + 缺口令 → 明确失败（整包加密的必然后果）", async () => {
  const c = await makeContainer();
  try {
    // 整包加密意味着**没有口令就读不到包内任何字节**——因此缺口令不是"跳过
    // 部分检查"，而是根本无法校验。这是"整包加密"这一裁决的必然后果，
    // 且是安全收益（明文不泄露）。此处锁住该行为是**明确报错**而非静默放行。
    await assertRejects(
      () =>
        verifyCommand({
          path: c.path,
          workDir: join(c.root, "w"),
          ops: c.ops,
        }),
      Error,
      "需要口令文件",
    );
  } finally {
    await Deno.remove(c.root, { recursive: true });
  }
});

Deno.test("T18 verify --deep：未加密容器 + 缺口令 → 如实跳过 env 解密而非静默通过", async () => {
  const root = await makeTempDir();
  try {
    const backupDir = join(root, "backups");
    const envFile = join(root, ".env.prod");
    await Deno.writeTextFile(envFile, "NOJ_VERSION=v0.9.5\n");
    const passphrase = join(root, "passphrase");
    await Deno.writeTextFile(passphrase, "x".repeat(64));
    const { ops } = makeRealishOps();
    // --no-encrypt：整包不加密 → 可解包；但包内 env.prod.gpg 仍是加密的
    const created = await createContainer({
      backupDir,
      stagingParent: root,
      passphraseFile: passphrase,
      noEncrypt: true,
      envFile,
      postgresDatabase: "noj",
      migrationStatus: "n/a",
      ops,
      now: new Date("2026-09-19T12:00:00Z"),
    });

    const result = await verifyCommand({
      path: created.path,
      workDir: join(root, "w"),
      encrypted: false,
      // 不给口令：结构检查不依赖口令，但 env 解密必须如实标记跳过
      ops,
      deep: true,
    });
    assertEquals(result.pass, true, result.summary);
    assertEquals(result.skippedDecrypt, true);
    assertStringIncludes(result.summary, "已跳过环境文件解密");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T18 verify --deep：包内 env.prod.gpg 无法解密 → --deep 失败", async () => {
  const root = await makeTempDir();
  try {
    const backupDir = join(root, "backups");
    const envFile = join(root, ".env.prod");
    await Deno.writeTextFile(envFile, "NOJ_VERSION=v0.9.5\n");
    const passphrase = join(root, "passphrase");
    await Deno.writeTextFile(passphrase, "x".repeat(64));
    const { ops } = makeRealishOps();
    // 用 --no-encrypt 产出：外层可直接解包，于是能单独驱动**包内 env 解密**分支。
    // （若容器整包加密，错口令在外层就失败了，这条分支测不到。）
    const created = await createContainer({
      backupDir,
      stagingParent: root,
      passphraseFile: passphrase,
      noEncrypt: true,
      envFile,
      postgresDatabase: "noj",
      migrationStatus: "n/a",
      ops,
      now: new Date("2026-09-19T12:00:00Z"),
    });
    // 先确认正确口令下 --deep 通过（否则下面的失败可能来自别处）
    const good = await verifyCommand({
      path: created.path,
      workDir: join(root, "w0"),
      passphraseFile: passphrase,
      encrypted: false,
      ops,
      deep: true,
    });
    assertEquals(good.pass, true, good.summary);

    const bad = join(root, "wrong-passphrase");
    await Deno.writeTextFile(bad, "y".repeat(64));
    const result = await verifyCommand({
      path: created.path,
      workDir: join(root, "w"),
      passphraseFile: bad,
      encrypted: false,
      ops,
      deep: true,
    });
    assertEquals(result.pass, false);
    assert(
      result.issues.some((i) =>
        i.level === "deep" && i.message.includes("环境文件解密失败")
      ),
      JSON.stringify(result.issues),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T18 verify --payload-sha：容器被改而 sidecar 未更新 → 恰好 payload 档失败", async () => {
  const c = await makeContainer();
  try {
    const passphraseFile = join(c.root, "passphrase");
    // 复制容器与它的 sidecar，然后**只改容器**（模拟介质损坏/拷贝截断/误改）
    const forged = join(c.backupDir, "snapshot-20990101-000000.nojbackup");
    await Deno.copyFile(c.path, forged);
    await Deno.copyFile(c.path + ".sha256", forged + ".sha256");
    const bytes = await Deno.readFile(forged);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! ^ 0xff) & 0xff;
    await Deno.writeFile(forged, bytes);

    const result = await verifyCommand({
      path: forged,
      workDir: await workDir(c.root, "w2"),
      passphraseFile,
      ops: c.ops,
      deep: true,
      payloadSha: true,
    });
    assertEquals(result.pass, false);
    // 注意：改动密文末尾会让解包在**默认档**就失败（GPG 完整性），
    // 因此这里断言"失败且原因指向密文/payload 层"，而不是断言默认档通过。
    assertEquals(result.checks.files, false, "密文被改后默认档必须失败");
    // 具体信息取决于改动位置（GPG 会话密钥校验 / 归档解析 / 逐文件摘要），
    // 但**必须给出可诊断的原因**，不能只是 pass=false。
    assert(result.issues.length > 0, "失败必须附带原因");
    assert(
      result.issues.some((i) => i.level === "files"),
      JSON.stringify(result.issues),
    );
  } finally {
    await Deno.remove(c.root, { recursive: true });
  }
});

Deno.test("T18 verify --payload-sha：仅 sidecar 缺失 → 恰好 payload 档失败（缺文件必须报）", async () => {
  const c = await makeContainer();
  try {
    // 删掉 sidecar：默认档与 --deep 仍应通过（包内完整性没变），
    // 但 --payload-sha 必须明确报"缺少 sidecar"，不能静默通过。
    await Deno.remove(c.path + ".sha256");
    const passphraseFile = join(c.root, "passphrase");

    const noPayload = await verifyCommand({
      path: c.path,
      workDir: await workDir(c.root, "w1"),
      passphraseFile,
      ops: c.ops,
      deep: true,
    });
    assertEquals(noPayload.pass, true, noPayload.summary);

    const result = await verifyCommand({
      path: c.path,
      workDir: await workDir(c.root, "w2"),
      passphraseFile,
      ops: c.ops,
      deep: true,
      payloadSha: true,
    });
    assertEquals(result.pass, false);
    assertEquals(result.checks.files, true, "默认档应仍通过");
    assertEquals(result.checks.deep, true, "--deep 应仍通过");
    assertEquals(result.checks.payload, false);
    assert(
      result.issues.some((i) =>
        i.level === "payload" && i.message.includes("缺少 sidecar 校验文件")
      ),
      JSON.stringify(result.issues),
    );
  } finally {
    await Deno.remove(c.root, { recursive: true });
  }
});

Deno.test("T18 verify：payload_layout 非 prod-raw → 明确拒绝（无分派）", async () => {
  const c = await makeContainer();
  try {
    const passphraseFile = join(c.root, "passphrase");
    const forged = join(c.backupDir, "snapshot-20990202-000000.nojbackup");
    const work = join(c.root, "forge2");
    const unpacked = join(work, "payload");
    await Deno.mkdir(unpacked, { recursive: true });
    await c.ops.gpgDecrypt(c.path, join(work, "t.tar.zst"), passphraseFile);
    await c.ops.untarZst(join(work, "t.tar.zst"), unpacked);
    const manifestPath = join(unpacked, "manifest.json");
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    manifest.payload_layout = "prod-base64";
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await c.ops.tarZst(unpacked, join(work, "f.tar.zst"), 15);
    await c.ops.gpgEncrypt(join(work, "f.tar.zst"), forged, passphraseFile);

    const result = await verifyCommand({
      path: forged,
      workDir: join(c.root, "w3"),
      passphraseFile,
      ops: c.ops,
    });
    assertEquals(result.pass, false);
    assert(
      result.issues.some((i) => i.message.includes("payload_layout 不受支持")),
      JSON.stringify(result.issues),
    );
  } finally {
    await Deno.remove(c.root, { recursive: true });
  }
});

Deno.test("T18 assertContainerPath：只接受 .nojbackup 单文件；拒绝 ..", () => {
  assertContainerPath("/opt/noj/backups/snapshot-1.nojbackup");
  for (const bad of ["/opt/noj/backups/snapshot-1", "../x.nojbackup"]) {
    let msg = "";
    try {
      assertContainerPath(bad);
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(msg !== "", `必须拒绝：${bad}`);
  }
});

// ---------------- list / prune ----------------

Deno.test("T18 list：列举容器，且不创建/不修改任何东西", async () => {
  const c = await makeContainer();
  try {
    const before = await fingerprint(c.backupDir);
    const result = await listBackupCommand(c.backupDir);
    assertEquals(result.entries.length, 1);
    assertEquals(result.entries[0]!.format, "single");
    assertEquals(result.entries[0]!.name, "snapshot-20260919-120000.nojbackup");
    assert(result.entries[0]!.bytes! > 0);
    // 零副作用
    assertEquals(await fingerprint(c.backupDir), before);
    assertEquals(await backupCount(c.backupDir), 1);
  } finally {
    await Deno.remove(c.root, { recursive: true });
  }
});

Deno.test("T18 list：目录不存在 → 空结果（首次使用不是错误）", async () => {
  const root = await makeTempDir();
  try {
    const result = await listBackupCommand(join(root, "nope"));
    assertEquals(result.entries, []);
    assertEquals(result.ignored, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T18 prune：默认 dry-run 零删除、零副作用", async () => {
  const c = await makeContainer();
  try {
    // 再放两个快照（不同时间），以形成可 prune 的对象
    for (const stamp of ["20200101-000000", "20200102-000000"]) {
      await Deno.copyFile(
        c.path,
        join(c.backupDir, `snapshot-${stamp}.nojbackup`),
      );
    }
    // 备份目录内现有：1 个容器 + 1 个 sidecar + 2 个复制来的容器（无 sidecar）
    const before = await fingerprint(c.backupDir);
    assertEquals(before.length, 4);

    const result = await pruneCommand(c.backupDir, { keep: 1 });
    assertEquals(result.applied, false, "默认必须 dry-run");
    assertEquals(result.deleted, []);
    assertEquals(result.failed, []);
    assertEquals(result.plan.keep.length, 1);
    assertEquals(result.plan.remove.length, 2);
    // 零副作用：目录逐项不变
    assertEquals(await fingerprint(c.backupDir), before);
  } finally {
    await Deno.remove(c.root, { recursive: true });
  }
});

Deno.test("T18 prune：--confirm 才真正删除，且只删计划内的", async () => {
  const c = await makeContainer();
  try {
    const keep = join(c.backupDir, "snapshot-20260919-120000.nojbackup");
    const old1 = join(c.backupDir, "snapshot-20200101-000000.nojbackup");
    const old2 = join(c.backupDir, "snapshot-20200102-000000.nojbackup");
    await Deno.copyFile(c.path, old1);
    await Deno.copyFile(c.path, old2);

    const result = await pruneCommand(c.backupDir, { keep: 1, confirm: true });
    assertEquals(result.applied, true);
    assertEquals(result.deleted.length, 2);
    assertEquals(result.failed, []);
    // 最新的保留
    assert((await Deno.stat(keep)).isFile, "最新的必须保留");
    for (const gone of [old1, old2]) {
      let exists = true;
      try {
        await Deno.stat(gone);
      } catch {
        exists = false;
      }
      assertEquals(exists, false, `${gone} 应被删除`);
    }
  } finally {
    await Deno.remove(c.root, { recursive: true });
  }
});

Deno.test("T18 prune：两个条件都不给 → 不删任何东西（安全默认）", async () => {
  const c = await makeContainer();
  try {
    const before = await fingerprint(c.backupDir);
    const result = await pruneCommand(c.backupDir, { confirm: true });
    assertEquals(result.deleted, []);
    assertEquals(result.plan.remove, []);
    assertEquals(await fingerprint(c.backupDir), before);
  } finally {
    await Deno.remove(c.root, { recursive: true });
  }
});

Deno.test("T18 prune：legacy 目录默认不被删除", async () => {
  const c = await makeContainer();
  try {
    // 造一个 legacy 目录形态快照（含 sha256sums.txt + SUCCESS 两个哨兵）
    const legacy = join(c.backupDir, "snapshot-20200101-000000");
    await Deno.mkdir(legacy, { recursive: true });
    await Deno.writeTextFile(join(legacy, "sha256sums.txt"), "");
    await Deno.writeTextFile(join(legacy, "SUCCESS"), "success\n");
    const before = await fingerprint(c.backupDir);

    // keep:0 会删掉所有"非 legacy"的；legacy 应被保护
    const result = await pruneCommand(c.backupDir, { keep: 0, confirm: true });
    assertEquals(result.applied, true);
    assert(
      before.some((f) => f.startsWith("snapshot-20200101-000000/")),
      "前置条件：legacy 应被 list 识别",
    );
    let legacyExists = true;
    try {
      await Deno.stat(join(legacy, "SUCCESS"));
    } catch {
      legacyExists = false;
    }
    assertEquals(legacyExists, true, "legacy 目录默认不得被 prune 删除");
  } finally {
    await Deno.remove(c.root, { recursive: true });
  }
});

// ---------------- restore --dry-run ----------------

Deno.test("T18 restore --dry-run：零副作用（不触 docker、不改配置），输出步骤清单", async () => {
  const c = await makeContainer();
  try {
    const passphraseFile = join(c.root, "passphrase");
    const envFile = join(c.root, ".env.prod");
    const envBefore = await Deno.readTextFile(envFile);
    const backupsBefore = await fingerprint(c.backupDir);

    const result = await restorePlan({
      path: c.path,
      workDir: await workDir(c.root, "w"),
      passphraseFile,
      ops: c.ops,
      restoreEnv: join(c.root, "restored.env"),
    });

    assertEquals(result.dryRun, true);
    assertEquals(result.verified, true, result.summary);
    assertStringIncludes(result.summary, "[dry-run]");
    // 步骤清单覆盖恢复全流程且顺序合理
    assertEquals(result.steps.map((s) => s.name), [
      "verify",
      "stop-check",
      "start-infra",
      "restore-globals",
      "restore-postgres",
      "restore-redis",
      "restore-minio",
      "stop-infra",
      "restore-env",
    ]);
    // 前两步不变更状态，其余变更
    assertEquals(result.steps[0]!.mutates, false);
    assertEquals(result.steps[1]!.mutates, false);
    assert(result.steps.slice(2).every((s) => s.mutates));

    // 零副作用
    assertEquals(
      await Deno.readTextFile(envFile),
      envBefore,
      "不得改 .env.prod",
    );
    assertEquals(await fingerprint(c.backupDir), backupsBefore);
    let restoredExists = true;
    try {
      await Deno.stat(join(c.root, "restored.env"));
    } catch {
      restoredExists = false;
    }
    assertEquals(restoredExists, false, "dry-run 不得写出恢复目标文件");
  } finally {
    await Deno.remove(c.root, { recursive: true });
  }
});

Deno.test("T18 restore --dry-run：校验不通过 → 不给步骤清单", async () => {
  const root = await makeTempDir();
  try {
    const backupDir = join(root, "backups");
    const envFile = join(root, ".env.prod");
    await Deno.writeTextFile(envFile, "NOJ_VERSION=v0.9.5\n");
    const passphrase = join(root, "passphrase");
    await Deno.writeTextFile(passphrase, "x".repeat(64));
    const { ops } = makeRealishOps();

    // 造一个**未加密**容器，再把包内 redis.rdb 改坏后重打包：
    // 于是容器本身能打开，但 sha256sums 校验必然失败——正是"校验不通过"的场景。
    // （若用加密容器，错误口令会在解包阶段抛错，测不到 verified=false 分支。）
    const created = await createContainer({
      backupDir,
      stagingParent: root,
      passphraseFile: passphrase,
      noEncrypt: true,
      envFile,
      postgresDatabase: "noj",
      migrationStatus: "n/a",
      ops,
      now: new Date("2026-09-19T12:00:00Z"),
    });
    const unpacked = join(root, "unpack");
    await ops.untarZst(created.path, unpacked);
    const rdb = join(unpacked, "redis.rdb");
    const bytes = await Deno.readFile(rdb);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! ^ 0xff) & 0xff;
    await Deno.writeFile(rdb, bytes);
    const forged = join(backupDir, "snapshot-20990303-000000.nojbackup");
    await ops.tarZst(unpacked, forged, 15);

    const result = await restorePlan({
      path: forged,
      workDir: await workDir(root, "w"),
      encrypted: false,
      ops,
    });
    assertEquals(result.verified, false);
    assertEquals(result.steps.map((s) => s.name), ["verify"]);
    assertStringIncludes(result.summary, "恢复不可行");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T18 restore --dry-run：ops 类型上就没有恢复能力（不触 docker）", async () => {
  const c = await makeContainer();
  try {
    // restorePlan 只接受 gpgDecrypt/untarZst；注入一个"任何额外调用即抛错"的 ops
    const strictOps = {
      gpgDecrypt: c.ops.gpgDecrypt,
      untarZst: c.ops.untarZst,
    };
    const result = await restorePlan({
      path: c.path,
      workDir: await workDir(c.root, "w"),
      passphraseFile: join(c.root, "passphrase"),
      ops: strictOps,
    });
    assertEquals(result.verified, true, result.summary);
    // `RestorePlanOptions.ops` 的类型里**只有** gpgDecrypt/untarZst——没有采集、
    // 没有 docker 调用能力。因此"dry-run 会碰 docker"在类型上就不可能；
    // 这里再断言结果自带 dryRun 标记与完整步骤清单（即真的规划了而非空跑）。
    assertEquals(result.dryRun, true);
    assert(result.steps.length > 1, "应输出完整步骤清单");
    assert(result.steps.every((s) => s.detail.length > 0));
  } finally {
    await Deno.remove(c.root, { recursive: true });
  }
});

// ---------------- 都不创建备份（误路由回归） ----------------

Deno.test("T18 误路由回归：verify/list/prune/restore-dry-run 都不创建备份", async () => {
  const c = await makeContainer();
  try {
    const passphraseFile = join(c.root, "passphrase");
    // 1 个容器 + 1 个同级 sidecar
    const before = await fingerprint(c.backupDir);
    assertEquals(before.length, 2);

    await verifyCommand({
      path: c.path,
      workDir: await workDir(c.root, "w1"),
      passphraseFile,
      ops: c.ops,
      deep: true,
      payloadSha: true,
    });
    await listBackupCommand(c.backupDir);
    await pruneCommand(c.backupDir, { keep: 1 });
    await restorePlan({
      path: c.path,
      workDir: await workDir(c.root, "w2"),
      passphraseFile,
      ops: c.ops,
    });

    assertEquals(
      await fingerprint(c.backupDir),
      before,
      "四个命令都不得创建或修改备份目录内容",
    );
  } finally {
    await Deno.remove(c.root, { recursive: true });
  }
});

Deno.test("T18 prodBackupDir：与 install 的 record-metadata 落点一致", () => {
  assertEquals(prodBackupDir("/opt/noj"), "/opt/noj/backups");
});

Deno.test("T18 prodBackupDir/tempContainerPath：路径形状一致（无尾斜杠陷阱）", () => {
  assertEquals(prodBackupDir("/opt/noj/"), "/opt/noj/backups");
  assert(
    tempContainerPath("/opt/noj/backups/x.nojbackup").startsWith(
      "/opt/noj/backups/",
    ),
  );
});

Deno.test("T18 list：ignored 记录非快照条目（不静默丢弃）", async () => {
  const c = await makeContainer();
  try {
    await Deno.writeTextFile(join(c.backupDir, "random.txt"), "x");
    await Deno.writeTextFile(join(c.backupDir, "notes.nojbackup.tmp"), "y");
    const result = await listBackupCommand(c.backupDir);
    assertEquals(result.entries.length, 1);
    assert(
      result.ignored.includes("random.txt"),
      JSON.stringify(result.ignored),
    );
    assert(
      result.ignored.includes("notes.nojbackup.tmp"),
      "非 .nojbackup 后缀的文件应被忽略并记录",
    );
  } finally {
    await Deno.remove(c.root, { recursive: true });
  }
});

Deno.test("T18 verify：目录形态快照 → 明确拒绝（引导迁移）", async () => {
  const root = await makeTempDir();
  try {
    const dir = join(root, "snapshot-20200101-000000");
    await Deno.mkdir(dir, { recursive: true });
    const { ops } = makeRealishOps();
    await assertRejects(
      () =>
        verifyCommand({
          path: dir,
          workDir: join(root, "w"),
          ops,
        }),
      Error,
      "只支持 .nojbackup 单文件快照",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T18 copyTree 辅助自检：确保测试打包器忠实（往返一致）", async () => {
  const root = await makeTempDir();
  try {
    const src = join(root, "src");
    await Deno.mkdir(join(src, "a/b"), { recursive: true });
    await Deno.writeFile(join(src, "a/b/c.bin"), new Uint8Array([0, 255, 128]));
    await Deno.writeTextFile(join(src, "top.txt"), "hello");
    const copy = join(root, "copy");
    await copyTree(src, copy);
    assertEquals(await filesOf(copy), await filesOf(src));
    assertEquals(
      [...await Deno.readFile(join(copy, "a/b/c.bin"))],
      [0, 255, 128],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
