import { assertEquals } from "@std/assert";
import type { CommandRunner } from "../runtime/command.ts";
import {
  prodBackupCreate,
  prodBackupDrill,
  prodBackupRestore,
} from "./backup.ts";

function recordingRunner(log: string[][]): CommandRunner {
  return {
    run(cmd, args, opts) {
      log.push([cmd, ...args]);
      let stdout = "";
      if (args.join(" ").includes("pg_dump ")) stdout = "dump";
      if (args.join(" ").includes("pg_dumpall")) stdout = "CREATE ROLE noj;";
      if (args.join(" ").includes("--rdb -")) stdout = "rdb";
      return Promise.resolve({
        code: opts?.stdin !== undefined ? 0 : 0,
        stdout,
        stderr: "",
      });
    },
    spawn() {
      throw new Error("not used");
    },
  };
}

Deno.test("prodBackupCreate: 生成快照目录", async () => {
  const dir = Deno.makeTempDirSync();
  const log: string[][] = [];
  const snapshot = await prodBackupCreate(
    {
      envFile: "/opt/.env.prod",
      composeFile: "/opt/compose.yml",
      backupDir: `${dir}/backups`,
      passphraseFile: "/etc/noj/pass",
    },
    recordingRunner(log),
  );
  assertEquals(snapshot.startsWith(`${dir}/backups/snapshot-`), true);
  assertEquals(Deno.statSync(snapshot).isDirectory, true);
});

Deno.test("prodBackupRestore: 未确认返回 1", async () => {
  const code = await prodBackupRestore({
    envFile: "/opt/.env.prod",
    composeFile: "/opt/compose.yml",
    backupDir: "/tmp",
    passphraseFile: "/etc/noj/pass",
    snapshot: "/tmp/snapshot-2026",
  }, recordingRunner([]));
  assertEquals(code, 1);
});

Deno.test("prodBackupDrill: 无 snapshot 返回 1", async () => {
  const code = await prodBackupDrill({
    envFile: "/opt/.env.prod",
    composeFile: "/opt/compose.yml",
    backupDir: "/tmp",
    passphraseFile: "/etc/noj/pass",
  }, recordingRunner([]));
  assertEquals(code, 1);
});
