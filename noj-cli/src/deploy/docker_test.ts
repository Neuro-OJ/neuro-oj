import { assertEquals } from "@std/assert";
import { dockerDown, dockerPs, dockerUp } from "./docker.ts";
import { recordingRunner } from "../testing/helpers.ts";

Deno.test("dockerUp: 调用 docker compose -f <path> up -d --wait", async () => {
  const records: string[][] = [];
  await dockerUp(
    recordingRunner(records, "ok"),
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
    recordingRunner(records, "ok"),
    "/opt/neuro-oj/docker-compose.noj.yml",
  );
  assertEquals(records, [
    ["docker", "compose", "-f", "/opt/neuro-oj/docker-compose.noj.yml", "down"],
  ]);
});

Deno.test("dockerPs: 调用 ... ps 并透传结果", async () => {
  const records: string[][] = [];
  const r = await dockerPs(
    recordingRunner(records, "ok"),
    "/opt/neuro-oj/docker-compose.noj.yml",
  );
  assertEquals(records, [
    ["docker", "compose", "-f", "/opt/neuro-oj/docker-compose.noj.yml", "ps"],
  ]);
  assertEquals(r.code, 0);
});
