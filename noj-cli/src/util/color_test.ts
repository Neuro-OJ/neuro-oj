import { assertEquals } from "@std/assert";
import { colorFor, parseColorMode, prefixLine, resolveColor } from "./color.ts";

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

/** 快照并恢复给定 env，避免污染其他测试。 */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev = new Map(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("resolveColor: --color=always 强制开", () => {
  withEnv({ NO_COLOR: undefined, LOG_COLOR: undefined }, () => {
    assertEquals(resolveColor("always", "stdout"), true);
  });
});

Deno.test("resolveColor: --color=never 强制关", () => {
  withEnv({ NO_COLOR: undefined, LOG_COLOR: undefined }, () => {
    assertEquals(resolveColor("never", "stdout"), false);
  });
});

Deno.test("resolveColor: NO_COLOR 优先于 always", () => {
  withEnv({ NO_COLOR: "1" }, () => {
    assertEquals(resolveColor("always", "stdout"), false);
  });
});

Deno.test("resolveColor: LOG_COLOR=always 覆盖 auto", () => {
  withEnv({ NO_COLOR: undefined, LOG_COLOR: "always" }, () => {
    assertEquals(resolveColor("auto", "stdout"), true);
  });
});

Deno.test("resolveColor: NO_COLOR 空串不算设置", () => {
  withEnv({ NO_COLOR: "", LOG_COLOR: "always" }, () => {
    assertEquals(resolveColor("auto", "stdout"), true);
  });
});

Deno.test("resolveColor: auto 且无 TTY 时关色（重定向不写转义码）", () => {
  // 测试进程的 stdout 不是 TTY；这是「noj-cli logs > out.txt」的等价场景。
  withEnv({ NO_COLOR: undefined, LOG_COLOR: undefined }, () => {
    assertEquals(resolveColor("auto", "stdout"), false);
  });
});

Deno.test("parseColorMode: 大小写不敏感，非法值回退 auto", () => {
  assertEquals(parseColorMode("always"), "always");
  assertEquals(parseColorMode("ALWAYS"), "always");
  assertEquals(parseColorMode(" Never "), "never");
  assertEquals(parseColorMode("bogus"), "auto");
  assertEquals(parseColorMode(undefined), "auto");
});

Deno.test("prefixLine: enabled=false 时不加着色", () => {
  const out = prefixLine("server", "hello\n", "\x1b[36m", false);
  assertEquals(out, "[server] hello");
  assertEquals(out.includes("\x1b["), false);
});
