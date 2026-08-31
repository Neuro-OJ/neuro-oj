import { assertEquals } from "@std/assert";
import type { CommandRunner } from "../runtime/command.ts";
import { dockerDown, dockerPs, dockerUp } from "./docker.ts";

/** 记录被调用的命令。 */
function recordingRunner(records: string[][]): CommandRunner {
  return {
    run(cmd, args) {
      records.push([cmd, ...args]);
      return Promise.resolve({ code: 0, stdout: "ok", stderr: "" });
    },
    spawn() {
      throw new Error("fake runner 不 spawn");
    },
  };
}

Deno.test("dockerUp: 调用 docker compose -f <path> up -d --wait", async () => {
  const records: string[][] = [];
  await dockerUp(
    recordingRunner(records),
    "/opt/neuro-oj/docker-compose.noj.yml",
  );
  assertEquals(records, [
    [
      "docker",
      "compose",
      "-f",
      "/opt/neuro-oj/docker-compose.noj.yml",
      "up",
      "-d",
      "--wait",
    ],
  ]);
});

Deno.test("dockerDown: 调用 ... down（不带 -v）", async () => {
  const records: string[][] = [];
  await dockerDown(
    recordingRunner(records),
    "/opt/neuro-oj/docker-compose.noj.yml",
  );
  assertEquals(records, [
    ["docker", "compose", "-f", "/opt/neuro-oj/docker-compose.noj.yml", "down"],
  ]);
});

Deno.test("dockerPs: 调用 ... ps 并透传结果", async () => {
  const records: string[][] = [];
  const r = await dockerPs(
    recordingRunner(records),
    "/opt/neuro-oj/docker-compose.noj.yml",
  );
  assertEquals(records, [
    ["docker", "compose", "-f", "/opt/neuro-oj/docker-compose.noj.yml", "ps"],
  ]);
  assertEquals(r.code, 0);
});
