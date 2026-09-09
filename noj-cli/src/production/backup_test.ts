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
        code: opts?.stdin !== undefined || opts?.stdinFile !== undefined
          ? 0
          : 0,
        stdout,
        stderr: "",
      });
    },
    spawn(opts) {
      log.push([opts.cmd, ...opts.args]);
      if (opts.stdoutFile) {
        Deno.writeTextFileSync(opts.stdoutFile, "dump");
      }
      return {
        pid: 1,
        wait() {
          return Promise.resolve(0);
        },
        async kill() {},
      };
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

Deno.test("prodBackupCreate: 导出命令失败时不写 SUCCESS", async () => {
  const dir = Deno.makeTempDirSync();
  const runner: CommandRunner = {
    run(_cmd, args) {
      if (args.join(" ").includes("pg_dumpall")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "boom" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn(opts) {
      if (opts.stdoutFile) {
        Deno.writeTextFileSync(opts.stdoutFile, "dump");
      }
      return {
        pid: 1,
        wait() {
          return Promise.resolve(0);
        },
        async kill() {},
      };
    },
  };
  let threw = false;
  try {
    await prodBackupCreate({
      envFile: "/opt/.env.prod",
      composeFile: "/opt/compose.yml",
      backupDir: `${dir}/backups`,
      passphraseFile: "/etc/noj/pass",
    }, runner);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  const backups = `${dir}/backups`;
  const entries = [...Deno.readDirSync(backups)];
  assertEquals(entries.length, 1);
  const snapshot = `${backups}/${entries[0]!.name}`;
  let hasSuccess = false;
  try {
    Deno.statSync(`${snapshot}/SUCCESS`);
    hasSuccess = true;
  } catch {
    // 期望不存在
  }
  assertEquals(hasSuccess, false);
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
