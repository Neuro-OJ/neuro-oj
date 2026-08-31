import { assertEquals, assertRejects } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "../config/types.ts";
import type { BackupDriver, DumpEntry } from "./backup_driver.ts";
import type {
  CommandRunner,
  SpawnHandle,
  SpawnOpts,
} from "../runtime/command.ts";
import {
  backupCreate,
  backupDrill,
  backupRestore,
  backupVerify,
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
    async archive(stagingDir, dest, _level) {
      // fake 用 JSON 容器模拟 tar+zstd：{ files: { relPath: content } }
      const files: Record<string, string> = {};
      async function walk(dir: string, base: string): Promise<void> {
        for await (const e of Deno.readDir(dir)) {
          const full = `${dir}/${e.name}`;
          const rel = `${base}${e.name}`;
          if (e.isDirectory) {
            await walk(full, `${rel}/`);
          } else {
            files[rel] = await Deno.readTextFile(full);
          }
        }
      }
      await walk(stagingDir, "");
      await Deno.writeTextFile(dest, JSON.stringify({ files }));
    },
    async extract(archive, destDir) {
      await Deno.mkdir(destDir, { recursive: true });
      const data = JSON.parse(await Deno.readTextFile(archive)) as {
        files: Record<string, string>;
      };
      for (const [rel, content] of Object.entries(data.files)) {
        const full = `${destDir}/${rel}`;
        const idx = full.lastIndexOf("/");
        if (idx > 0) await Deno.mkdir(full.slice(0, idx), { recursive: true });
        await Deno.writeTextFile(full, content);
      }
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
      ]);
    },
    async restoreDataDumps() {},
    async clearData() {},
  };
}

/** 模拟 docker compose 成功执行的 fake runner。 */
function fakeRunner(): CommandRunner {
  return {
    run(_cmd, _args) {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn(_opts: SpawnOpts): SpawnHandle {
      throw new Error("fake runner 不 spawn");
    },
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

Deno.test("backupVerify: 合法快照 pass=true", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, prodConfig(), secrets());
  await backupCreate({
    dir,
    backupDir: `${dir}/backups`,
    noEncrypt: true,
    driver: fakeDriver(),
    zstdLevel: 15,
  });
  const entries = await Array.fromAsync(Deno.readDir(`${dir}/backups`));
  const snap = `${dir}/backups/${entries[0]!.name}`;
  const report = await backupVerify({
    snapshotPath: snap,
    driver: fakeDriver(),
  });
  assertEquals(report.pass, true);
  assertEquals(report.errors.length, 0);
});

Deno.test("backupRestore: 要求 confirm；running 时先 down 再恢复", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, prodConfig(), secrets());
  // 未 confirm
  await assertRejects(
    () =>
      backupRestore({
        dir,
        snapshotPath: "/nonexistent",
        confirm: false,
        driver: fakeDriver(),
        runner: fakeRunner(),
      }),
    Error,
    "confirm",
  );
  // 先创建合法快照，再从 running 恢复
  await backupCreate({
    dir,
    backupDir: `${dir}/backups`,
    noEncrypt: true,
    driver: fakeDriver(),
  });
  const entries = await Array.fromAsync(Deno.readDir(`${dir}/backups`));
  const snap = `${dir}/backups/${entries[0]!.name}`;
  const state = await backupRestore({
    dir,
    snapshotPath: snap,
    confirm: true,
    driver: fakeDriver(),
    runner: fakeRunner(),
  });
  assertEquals(state, "stopped");
  const saved = JSON.parse(
    await Deno.readTextFile(`${dir}/noj-deploy.json`),
  ) as DeployConfig;
  assertEquals(saved.state, "stopped");
});

Deno.test("backupDrill: 写报告文件", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, prodConfig(), secrets());
  await backupCreate({
    dir,
    backupDir: `${dir}/backups`,
    noEncrypt: true,
    driver: fakeDriver(),
  });
  const entries = await Array.fromAsync(Deno.readDir(`${dir}/backups`));
  const snap = `${dir}/backups/${entries[0]!.name}`;
  const reportPath = `${dir}/report.json`;
  const report = await backupDrill({
    snapshotPath: snap,
    report: reportPath,
    driver: fakeDriver(),
  });
  const text = await Deno.readTextFile(reportPath);
  assertEquals(JSON.parse(text).pass, report.pass);
});

Deno.test("backupRestore --include-deploy-configs: 恢复后强制 state=stopped", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, prodConfig(), secrets());
  await backupCreate({
    dir,
    backupDir: `${dir}/backups`,
    noEncrypt: true,
    driver: fakeDriver(),
  });
  const entries = await Array.fromAsync(Deno.readDir(`${dir}/backups`));
  const snap = `${dir}/backups/${entries[0]!.name}`;
  const state = await backupRestore({
    dir,
    snapshotPath: snap,
    confirm: true,
    includeDeployConfigs: true,
    driver: fakeDriver(),
    runner: fakeRunner(),
  });
  assertEquals(state, "stopped");
  const saved = JSON.parse(
    await Deno.readTextFile(`${dir}/noj-deploy.json`),
  ) as DeployConfig;
  assertEquals(saved.state, "stopped");
});
