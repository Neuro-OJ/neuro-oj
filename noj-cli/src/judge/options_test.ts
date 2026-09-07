import { assertEquals, assertThrows } from "@std/assert";
import { DEFAULT_JUDGE_DIR, parseJudgeArgs } from "./options.ts";

Deno.test("parseJudgeArgs: 缺省值", () => {
  const o = parseJudgeArgs(["install"]);
  assertEquals(o.command, "install");
  assertEquals(o.dir, DEFAULT_JUDGE_DIR);
  assertEquals(o.envFile, `${DEFAULT_JUDGE_DIR}/.env.judge`);
  assertEquals(o.composeFile, `${DEFAULT_JUDGE_DIR}/docker-compose.judge.yml`);
  assertEquals(o.repo, "https://github.com/Neuro-OJ/neuro-oj");
  assertEquals(o.ref, "main");
  assertEquals(o.nonInteractive, false);
  assertEquals(o.dryRun, false);
  assertEquals(o.follow, false);
});

Deno.test("parseJudgeArgs: 解析选项", () => {
  const o = parseJudgeArgs([
    "check",
    "--dir",
    "/srv/noj",
    "--env-file",
    "/tmp/env",
    "--compose-file",
    "/tmp/compose.yml",
    "--version",
    "v0.2.0",
    "--panel",
    "none",
    "--non-interactive",
    "--dry-run",
    "--follow",
  ]);
  assertEquals(o.command, "check");
  assertEquals(o.dir, "/srv/noj");
  assertEquals(o.envFile, "/tmp/env");
  assertEquals(o.composeFile, "/tmp/compose.yml");
  assertEquals(o.version, "v0.2.0");
  assertEquals(o.panel, "none");
  assertEquals(o.nonInteractive, true);
  assertEquals(o.dryRun, true);
  assertEquals(o.follow, true);
});

Deno.test("parseJudgeArgs: 非法 panel 抛错", () => {
  assertThrows(() => parseJudgeArgs(["install", "--panel", "bad"]));
});
