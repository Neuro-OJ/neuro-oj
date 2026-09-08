import { assertEquals } from "@std/assert";
import type { CmdResult, CommandRunner } from "../runtime/command.ts";
import { runRestoreDrill } from "./drill.ts";
import type { RestoreDrillOptions } from "./options.ts";

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
    "migration-status.txt": "hash:2026-09-07",
    "sha256sums.txt": "",
  };
  Deno.mkdirSync(`${dir}/minio`);
  Deno.mkdirSync(`${dir}/minio/obj`);
  Deno.writeTextFileSync(`${dir}/minio/obj/a`, "a");
  for (const [name, content] of Object.entries(files)) {
    Deno.writeTextFileSync(`${dir}/${name}`, content);
  }
  return dir;
}

function fakeRunner(): CommandRunner {
  return {
    run(cmd, args, opts) {
      const joined = args.join(" ");
      let stdout = "";
      if (joined.includes("drizzle.__drizzle_migrations")) {
        stdout = "hash:2026-09-07";
      }
      if (joined.includes("count(*) FROM users")) stdout = "3";
      if (joined.includes("DBSIZE")) stdout = "5";
      if (joined.includes("mc ls --recursive")) stdout = "2";
      const code = opts?.stdin !== undefined || cmd === "docker" ? 0 : 0;
      return Promise.resolve({ code, stdout, stderr: "" } as CmdResult);
    },
    spawn() {
      throw new Error("not used");
    },
  };
}

function optsFor(snapshot: string, pass: string): RestoreDrillOptions {
  return {
    snapshot,
    envFile: "/tmp/.env.prod",
    composeFile: "/tmp/docker-compose.prod.yml",
    passphraseFile: pass,
    projectName: "noj-drill-test",
    drillDir: undefined,
    report: undefined,
    subnet: "172.29.0.0/16",
    rpoMaxHours: 24,
    rtoMaxMinutes: 60,
    waitTimeout: 5,
    skipJudge: true,
    keep: true,
  };
}

Deno.test("runRestoreDrill: skip-judge 成功", async () => {
  const root = Deno.makeTempDirSync();
  const snapshot = makeSnapshot(`${root}/snapshot-20260907`);
  const pass = `${root}/pass`;
  Deno.writeTextFileSync(pass, "pass");
  Deno.chmodSync(pass, 0o600);
  const code = await runRestoreDrill(optsFor(snapshot, pass), fakeRunner());
  assertEquals(code, 0);
});

Deno.test("runRestoreDrill: 缺少 passphrase 返回 1", async () => {
  const root = Deno.makeTempDirSync();
  const snapshot = makeSnapshot(`${root}/snapshot-20260907`);
  const opts = optsFor(snapshot, "");
  const code = await runRestoreDrill(opts, fakeRunner());
  assertEquals(code, 1);
});
