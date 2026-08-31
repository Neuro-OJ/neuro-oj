import { assertEquals, assertRejects } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "../config/types.ts";
import type { BackupDriver, DumpEntry } from "./backup_driver.ts";
import {
  backupCreate,
  resolvePassphraseFile,
  snapshotFileName,
  writeSha256Sums,
} from "./backup.ts";

function prodConfig(): DeployConfig {
  return {
    schema_version: 1,
    type: "prod",
    state: "running",
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    install_dir: "/opt/neuro-oj",
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: {},
    components: {
      postgres: {
        enabled: true,
        method: "docker",
        image: "postgres:16-alpine",
        internal_port: 5432,
        env: {},
      },
    },
    reverse_proxy: {
      type: "nginx",
      config_dir: "/etc/nginx/conf.d",
      domain: "oj.example.com",
      upstream_port: 8080,
    },
  };
}

function devConfig(): DeployConfig {
  return { ...prodConfig(), type: "dev" };
}

function secrets(): SecretsConfig {
  return {
    schema_version: 1,
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    secrets: {},
  };
}

async function writeFixture(
  dir: string,
  cfg: DeployConfig,
  sec: SecretsConfig,
): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/noj-deploy.json`, JSON.stringify(cfg));
  await Deno.writeTextFile(`${dir}/noj-secrets.json`, JSON.stringify(sec));
}

/** 记录调用、返回 fake dump 的 fake driver。 */
function fakeDriver(): BackupDriver {
  return {
    async archive(stagingDir, _dest, _level) {
      // 真实实现会打包；fake 直接把 staging 内容复制到 dest 作为"压缩后"文件
      const entries = await Array.fromAsync(Deno.readDir(stagingDir));
      for (const e of entries) {
        if (e.isFile) {
          const content = await Deno.readTextFile(`${stagingDir}/${e.name}`);
          await Deno.writeTextFile(`${_dest}.${e.name}`, content);
        }
      }
      await Deno.writeTextFile(_dest, "fake-archive");
    },
    async extract(archive, destDir) {
      await Deno.writeTextFile(`${destDir}/SUCCESS`, "ok");
      void archive;
    },
    async gpgEncrypt(src, dest, _pf) {
      await Deno.copyFile(src, dest);
    },
    async gpgDecrypt(src, dest, _pf) {
      await Deno.copyFile(src, dest);
    },
    produceDataDumps(_c, _s, _d): Promise<DumpEntry[]> {
      return Promise.resolve([
        { relPath: "postgres.dump", content: "dump-bytes" },
        { relPath: "postgres-globals.sql", content: "-- globals" },
        { relPath: "postgres.restore-list", content: "1;" },
      ]);
    },
    async restoreDataDumps() {},
    async clearData() {},
  };
}

Deno.test("snapshotFileName: 生成合法快照文件名", () => {
  const name = snapshotFileName(new Date("2026-08-31T12:34:56Z"));
  assertEquals(name, "snapshot-2026-08-31T12-34-56Z.nojbackup");
});

Deno.test("resolvePassphraseFile: 旗标优先，回退环境变量，最后 null", () => {
  const old = Deno.env.get("NOJ_BACKUP_PASSPHRASE_FILE");
  Deno.env.delete("NOJ_BACKUP_PASSPHRASE_FILE");
  try {
    assertEquals(resolvePassphraseFile("/pw.txt"), "/pw.txt");
    Deno.env.set("NOJ_BACKUP_PASSPHRASE_FILE", "/env-pw.txt");
    assertEquals(resolvePassphraseFile(undefined), "/env-pw.txt");
    assertEquals(resolvePassphraseFile("/pw.txt"), "/pw.txt");
  } finally {
    if (old === undefined) Deno.env.delete("NOJ_BACKUP_PASSPHRASE_FILE");
    else Deno.env.set("NOJ_BACKUP_PASSPHRASE_FILE", old);
  }
});

Deno.test("writeSha256Sums: 写出两空格分隔的 sha256sums.txt", async () => {
  const dir = await Deno.makeTempDir();
  await writeSha256Sums(dir, [
    { relPath: "postgres.dump", sha256: "a".repeat(64) },
    { relPath: "SUCCESS", sha256: "b".repeat(64) },
  ]);
  const text = await Deno.readTextFile(`${dir}/sha256sums.txt`);
  assertEquals(
    text,
    `${"a".repeat(64)}  postgres.dump\n${"b".repeat(64)}  SUCCESS\n`,
  );
});

Deno.test("backupCreate: 加密模式生成 .nojbackup 并返回 sha256", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, prodConfig(), secrets());
  const out = await backupCreate({
    dir,
    backupDir: `${dir}/backups`,
    passphraseFile: "/pw.txt",
    zstdLevel: 15,
    noEncrypt: false,
    driver: fakeDriver(),
  });
  const exists = await Deno.stat(out.path);
  assertEquals(exists.isFile, true);
  assertEquals(out.path.endsWith(".nojbackup"), true);
  // 非空且为 64 位 hex
  assertEquals(/^[0-9a-f]{64}$/.test(out.sha256), true);
});

Deno.test("backupCreate: --no-encrypt 也可生成产物", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, prodConfig(), secrets());
  const out = await backupCreate({
    dir,
    backupDir: `${dir}/backups`,
    zstdLevel: 15,
    noEncrypt: true,
    driver: fakeDriver(),
  });
  assertEquals(await Deno.stat(out.path).then((s) => s.isFile), true);
  assertEquals(/^[0-9a-f]{64}$/.test(out.sha256), true);
});

Deno.test("backupCreate: dev 类型拒绝", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, devConfig(), secrets());
  await assertRejects(
    () => backupCreate({ dir, noEncrypt: true, driver: fakeDriver() }),
    Error,
    "仅面向 prod",
  );
});
