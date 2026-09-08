import { assertEquals, assertThrows } from "@std/assert";
import type { CommandRunner } from "../runtime/command.ts";
import {
  checkSecretFile,
  checkSnapshotFiles,
  hoursSinceSnapshot,
  snapshotCreatedAt,
  validateSnapshotPath,
  verifySnapshot,
} from "./snapshot.ts";

function fakeRunner(): CommandRunner {
  return {
    run() {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn() {
      throw new Error("not used");
    },
  };
}

function makeSnapshot(dir: string): string {
  Deno.mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {
    "SUCCESS": "success\n",
    "manifest.json": '{"created_at":"2026-09-07T00:00:00Z"}',
    "env.prod.gpg": "encrypted",
    "postgres.dump": "dump",
    "postgres-globals.sql": "CREATE ROLE noj;",
    "postgres.restore-list": "1; TABLE public users noj",
    "redis.rdb": "rdb",
    "sha256sums.txt": "",
  };
  Deno.mkdirSync(`${dir}/minio`);
  for (const [name, content] of Object.entries(files)) {
    Deno.writeTextFileSync(`${dir}/${name}`, content);
  }
  return dir;
}

Deno.test("validateSnapshotPath: 合法快照返回绝对路径", () => {
  const dir = makeSnapshot(`${Deno.makeTempDirSync()}/snapshot-20260907`);
  const abs = validateSnapshotPath(dir);
  assertEquals(abs.startsWith("/"), true);
});

Deno.test("validateSnapshotPath: 非法路径抛错", () => {
  const dir = Deno.makeTempDirSync();
  assertThrows(() => validateSnapshotPath(`${dir}/not-snapshot`));
});

Deno.test("checkSnapshotFiles: 完整快照无问题", () => {
  const dir = makeSnapshot(`${Deno.makeTempDirSync()}/snapshot-20260907`);
  assertEquals(checkSnapshotFiles(dir), []);
});

Deno.test("checkSecretFile: 权限校验", () => {
  const file = `${Deno.makeTempDirSync()}/pass`;
  Deno.writeTextFileSync(file, "pass");
  Deno.chmodSync(file, 0o600);
  assertEquals(checkSecretFile(file), []);
  Deno.chmodSync(file, 0o644);
  assertEquals(checkSecretFile(file).length > 0, true);
});

Deno.test("snapshotCreatedAt/hoursSinceSnapshot", () => {
  const dir = makeSnapshot(`${Deno.makeTempDirSync()}/snapshot-20260907`);
  assertEquals(snapshotCreatedAt(dir), "2026-09-07T00:00:00Z");
  assertEquals(typeof hoursSinceSnapshot("2026-09-07T00:00:00Z"), "number");
});

Deno.test("verifySnapshot: 成功路径", async () => {
  const dir = makeSnapshot(`${Deno.makeTempDirSync()}/snapshot-20260907`);
  const pass = `${Deno.makeTempDirSync()}/pass`;
  Deno.writeTextFileSync(pass, "pass");
  Deno.chmodSync(pass, 0o600);
  const problems = await verifySnapshot({
    snapshot: dir,
    envFile: "/tmp/.env.prod",
    composeFile: "/tmp/compose.yml",
    passphraseFile: pass,
    runner: fakeRunner(),
  });
  assertEquals(problems, []);
});
