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

Deno.test("parseJudgeArgs: 混用等号与空格时后者覆盖 dir", () => {
  const o = parseJudgeArgs(["install", "--dir=/a", "--dir", "/b"]);
  assertEquals(o.dir, "/b");
});

Deno.test("parseJudgeArgs: 重复空格形式 dir 使用最后一个值", () => {
  const o = parseJudgeArgs(["install", "--dir", "/a", "--dir", "/b"]);
  assertEquals(o.dir, "/b");
});

Deno.test("parseJudgeArgs: 值缺失且下一个是选项时抛错", () => {
  assertThrows(() => parseJudgeArgs(["install", "--dir", "--dry-run"]));
});

Deno.test("parseJudgeArgs: 非法 redis-port 抛错", () => {
  assertThrows(() => parseJudgeArgs(["install", "--redis-port", "abc"]));
});

Deno.test("parseJudgeArgs: 等号风格选项", () => {
  const o = parseJudgeArgs([
    "install",
    "--dir=/srv/noj",
    "--env-file=/tmp/env",
  ]);
  assertEquals(o.dir, "/srv/noj");
  assertEquals(o.envFile, "/tmp/env");
});

Deno.test("parseJudgeArgs: 缺少子命令抛错", () => {
  assertThrows(() => parseJudgeArgs([]));
});

Deno.test("parseJudgeArgs: 未知参数抛错", () => {
  assertThrows(() => parseJudgeArgs(["install", "--unknown"]));
});
