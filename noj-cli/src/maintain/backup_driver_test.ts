import { assertEquals } from "@std/assert";
import type {
  CmdResult,
  CommandRunner,
  SpawnHandle,
  SpawnOpts,
} from "../runtime/command.ts";
import type { DeployConfig, SecretsConfig } from "../config/types.ts";
import { fileSha256Hex, realDriver, sha256Hex } from "./backup_driver.ts";

/** 记录 run 调用的 fake runner。 */
function recordingRunner(records: string[][]): CommandRunner {
  return {
    run(cmd, args) {
      records.push([cmd, ...args]);
      return Promise.resolve(
        { code: 0, stdout: "", stderr: "" } satisfies CmdResult,
      );
    },
    spawn(_opts: SpawnOpts): SpawnHandle {
      throw new Error("fake runner 不 spawn");
    },
  };
}

Deno.test("sha256Hex: SHA-256 已知摘要", async () => {
  const h = await sha256Hex(new TextEncoder().encode("abc"));
  assertEquals(
    h,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("fileSha256Hex: 读文件算摘要", async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/a.txt`;
  await Deno.writeTextFile(p, "hello");
  const h = await fileSha256Hex(p);
  assertEquals(
    h,
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

Deno.test("realDriver.archive: tar -I zstd -<level> -cf", async () => {
  const records: string[][] = [];
  const d = realDriver(recordingRunner(records));
  await d.archive("/s", "/out.tar.zst", 15);
  assertEquals(records[0], [
    "tar",
    "-I",
    "zstd -15",
    "-cf",
    "/out.tar.zst",
    "-C",
    "/s",
    ".",
  ]);
});

Deno.test("realDriver.extract: tar -I zstd -xf", async () => {
  const records: string[][] = [];
  const d = realDriver(recordingRunner(records));
  const dir = await Deno.makeTempDir();
  const dest = `${dir}/d`;
  await d.extract("/a.tar.zst", dest);
  assertEquals(records[0], [
    "tar",
    "-I",
    "zstd",
    "-xf",
    "/a.tar.zst",
    "-C",
    dest,
  ]);
});

Deno.test("realDriver.gpgEncrypt: --symmetric AES256", async () => {
  const records: string[][] = [];
  const d = realDriver(recordingRunner(records));
  await d.gpgEncrypt("/src.tar.zst", "/out.nojbackup", "/pw.txt");
  assertEquals(records[0], [
    "gpg",
    "--batch",
    "--yes",
    "--symmetric",
    "--cipher-algo",
    "AES256",
    "--passphrase-file",
    "/pw.txt",
    "--output",
    "/out.nojbackup",
    "/src.tar.zst",
  ]);
});

interface RunRecord {
  args: string[];
  opts?: { cwd?: string; env?: Record<string, string>; stdin?: string };
}

function recordingRunnerWithOpts(records: RunRecord[]): CommandRunner {
  return {
    run(cmd, args, opts) {
      records.push({ args: [cmd, ...args], opts });
      return Promise.resolve(
        { code: 0, stdout: "", stderr: "" } satisfies CmdResult,
      );
    },
    spawn(_opts: SpawnOpts): SpawnHandle {
      throw new Error("fake runner 不 spawn");
    },
  };
}

function driverConfig(): DeployConfig {
  return {
    schema_version: 1,
    type: "prod",
    state: "stopped",
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
        env: {
          POSTGRES_USER: "noj",
          POSTGRES_DB: "noj",
          POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}",
        },
      },
      redis: {
        enabled: true,
        method: "docker",
        image: "redis:7-alpine",
        internal_port: 6379,
        env: { REDIS_PASSWORD: "${REDIS_PASSWORD}" },
      },
      minio: {
        enabled: true,
        method: "docker",
        image: "minio/minio:latest",
        api_port: 9000,
        console_port: 9001,
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

function driverSecrets(): SecretsConfig {
  return {
    schema_version: 1,
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    secrets: {
      POSTGRES_PASSWORD: "p'w",
      REDIS_PASSWORD: "r'w",
    },
  };
}

Deno.test("realDriver.produceDataDumps: 凭据经 -e 传入，不拼进 shell 字符串", async () => {
  const records: RunRecord[] = [];
  const d = realDriver(recordingRunnerWithOpts(records));
  const dumpDir = await Deno.makeTempDir();
  const entries = await d.produceDataDumps(
    driverConfig(),
    driverSecrets(),
    dumpDir,
  );
  assertEquals(entries.some((e) => e.relPath === "postgres.dump"), true);
  assertEquals(entries.some((e) => e.relPath === "redis.rdb"), true);
  // 所有 docker exec 参数中不得出现旧式单引号拼 secret 的形态
  for (const rec of records) {
    for (const arg of rec.args) {
      assertEquals(arg.includes("PGPASSWORD='"), false);
      assertEquals(arg.includes("REDISCLI_AUTH='"), false);
    }
  }
  // 至少有一次通过 -e 传 PGPASSWORD
  assertEquals(
    records.some((r) =>
      r.args.includes("-e") && r.args.includes("PGPASSWORD=p'w")
    ),
    true,
  );
});

Deno.test("realDriver.restoreDataDumps: 经 stdin 传 base64，且先起基础设施由编排负责", async () => {
  const records: RunRecord[] = [];
  const d = realDriver(recordingRunnerWithOpts(records));
  const dumpDir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dumpDir}/postgres.dump`, "cG9zdGdyZXM=");
  await Deno.writeTextFile(`${dumpDir}/postgres-globals.sql`, "-- globals");
  await Deno.writeTextFile(`${dumpDir}/redis.rdb`, "cmVkaXM=");
  await d.restoreDataDumps(driverConfig(), driverSecrets(), dumpDir);
  // postgres 恢复使用 stdin 且命令串不含 secret
  const pgRestore = records.find((r) =>
    r.args.some((a) => a.includes("pg_restore"))
  );
  assertEquals(pgRestore !== undefined, true);
  assertEquals(pgRestore!.opts?.stdin, "cG9zdGdyZXM=");
  const pgCmd = pgRestore!.args.find((a) => a.includes("pg_restore"))!;
  assertEquals(pgCmd.includes("p'w"), false);
  // redis RDB 恢复使用 stdin
  const redisRestore = records.find((r) =>
    r.args.some((a) => a.includes("base64 -d > /data/dump.rdb"))
  );
  assertEquals(redisRestore !== undefined, true);
  assertEquals(redisRestore!.opts?.stdin, "cmVkaXM=");
});

Deno.test("realDriver.clearData: 使用 -e 传凭据，不拼 secret 进 shell", async () => {
  const records: RunRecord[] = [];
  const d = realDriver(recordingRunnerWithOpts(records));
  await d.clearData(driverConfig(), driverSecrets());
  for (const rec of records) {
    for (const arg of rec.args) {
      assertEquals(arg.includes("PGPASSWORD='"), false);
      assertEquals(arg.includes("REDISCLI_AUTH='"), false);
    }
  }
  assertEquals(
    records.some((r) =>
      r.args.includes("-e") && r.args.includes("PGPASSWORD=p'w")
    ),
    true,
  );
});
