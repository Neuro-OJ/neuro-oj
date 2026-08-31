import { assertEquals } from "@std/assert";
import { colorFor, prefixLine } from "./color.ts";

Deno.test("colorFor: 同名恒同色，不同名可能不同色", () => {
  assertEquals(colorFor("server"), colorFor("server"));
  const palette = new Set<string>();
  for (const n of ["server", "ui", "judge", "postgres", "redis"]) {
    palette.add(colorFor(n));
  }
  // 调色板至少两种不同颜色，保证"不同模块不同色"的语义可被观察
  assertEquals(palette.size >= 2, true);
});

Deno.test("colorFor: 返回 ANSI 前景色码并以 m 结尾", () => {
  const c = colorFor("server");
  assertEquals(c.startsWith("\x1b["), true);
  assertEquals(c.endsWith("m"), true);
});

Deno.test("prefixLine: 加彩色模块前缀并去掉行尾换行", () => {
  const out = prefixLine("server", "hello\n", "\x1b[36m");
  assertEquals(out, "\x1b[36m[server] hello\x1b[0m");
});
