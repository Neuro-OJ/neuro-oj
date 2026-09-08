import { assertEquals } from "@std/assert";
import type { CommandRunner } from "../runtime/command.ts";
import {
  prodLogs,
  prodRestart,
  prodStart,
  prodStatus,
  prodStop,
} from "./lifecycle.ts";

function recordingRunner(log: string[][]): CommandRunner {
  return {
    run(cmd, args) {
      log.push([cmd, ...args]);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn() {
      throw new Error("not used");
    },
  };
}

const opts = {
  envFile: "/opt/.env.prod",
  composeFile: "/opt/docker-compose.prod.yml",
};

Deno.test("prodStart: 调用 compose up", async () => {
  const log: string[][] = [];
  const code = await prodStart(opts, recordingRunner(log));
  assertEquals(code, 0);
  const call = log[0]!;
  assertEquals(call[0], "docker");
  assertEquals(call.includes("up"), true);
});

Deno.test("prodStop: 调用 compose stop", async () => {
  const log: string[][] = [];
  const code = await prodStop(opts, recordingRunner(log));
  assertEquals(code, 0);
  assertEquals(log[0]!.includes("stop"), true);
});

Deno.test("prodRestart: 先 stop 再 start", async () => {
  const log: string[][] = [];
  const code = await prodRestart(opts, recordingRunner(log));
  assertEquals(code, 0);
  assertEquals(log[0]!.includes("stop"), true);
  assertEquals(log[1]!.includes("up"), true);
});

Deno.test("prodStatus/prodLogs: 调用 compose ps/logs", async () => {
  const log1: string[][] = [];
  await prodStatus(opts, recordingRunner(log1));
  assertEquals(log1[0]!.includes("ps"), true);
  const log2: string[][] = [];
  await prodLogs({ ...opts, follow: true }, recordingRunner(log2));
  assertEquals(log2[0]!.includes("logs"), true);
  assertEquals(log2[0]!.includes("--follow"), true);
});
