import { assertEquals } from "@std/assert";
import {
  levenshtein,
  parseDirArg,
  suggestCommand,
  UsageError,
} from "./args.ts";

Deno.test("parseDirArg: --dir <path> 与 --dir=<path> 等价", () => {
  assertEquals(parseDirArg(["--dir", "/opt"]), "/opt");
  assertEquals(parseDirArg(["--dir=/opt"]), "/opt");
});

Deno.test("parseDirArg: 无 --dir 返回 undefined", () => {
  assertEquals(parseDirArg([]), undefined);
  assertEquals(parseDirArg(["--follow"]), undefined);
});

Deno.test("parseDirArg: 缺值显式报错（不再静默 undefined）", () => {
  // 回归防线（E6）：早先 `--dir` 缺值会静默取到 undefined，用户以为生效了。
  for (const argv of [["--dir"], ["--dir="], ["--dir", "--follow"]]) {
    let err: unknown;
    try {
      parseDirArg(argv);
    } catch (e) {
      err = e;
    }
    assertEquals(err instanceof UsageError, true, JSON.stringify(argv));
  }
});

Deno.test("parseDirArg: 报错信息可操作", () => {
  try {
    parseDirArg(["--dir"]);
  } catch (e) {
    assertEquals((e as Error).message.includes("--dir"), true);
    assertEquals((e as Error).message.includes("目录"), true);
  }
});

Deno.test("levenshtein: 已知距离", () => {
  assertEquals(levenshtein("instal", "install"), 1);
  assertEquals(levenshtein("statu", "status"), 1);
  assertEquals(levenshtein("", "abc"), 3);
  assertEquals(levenshtein("abc", "abc"), 0);
});

Deno.test("suggestCommand: 近似输入给出建议，过远不给", () => {
  const known = ["install", "status", "logs", "backup", "verify"];
  assertEquals(suggestCommand("instal", known), "install");
  assertEquals(suggestCommand("statu", known), "status");
  // 距离过远：不应胡乱建议
  assertEquals(suggestCommand("zzzzzzzz", known), undefined);
});

Deno.test("suggestCommand: 大小写与前后空白容错", () => {
  const known = ["status"];
  assertEquals(suggestCommand("  STATUS ", known), "status");
});
