import { assertEquals } from "@std/assert";
import { flagValue, levenshtein, suggestCommand, UsageError } from "./args.ts";

Deno.test("flagValue: --flag v 与 --flag=v 等价，未出现返回 undefined", () => {
  assertEquals(flagValue(["--dir", "/opt"], "--dir"), "/opt");
  assertEquals(flagValue(["--dir=/opt"], "--dir"), "/opt");
  assertEquals(flagValue(["--follow"], "--dir"), undefined);
});

Deno.test("flagValue: 缺值显式报用法错误（不静默 undefined）", () => {
  for (const argv of [["--dir"], ["--dir="], ["--dir", "--follow"]]) {
    let err: unknown;
    try {
      flagValue(argv, "--dir", "--dir 需要一个安装目录");
    } catch (e) {
      err = e;
    }
    assertEquals(err instanceof UsageError, true, JSON.stringify(argv));
    assertEquals((err as Error).message, "--dir 需要一个安装目录");
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
