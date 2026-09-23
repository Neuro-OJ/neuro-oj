import { assertEquals } from "@std/assert";
import { COLOR_MODES, type ColorMode, resolveColor } from "../util/color.ts";
import {
  createTheme,
  SEMANTIC_ANSI,
  SEMANTIC_TOKEN_NAMES,
  STATUS_SYMBOL,
  type StatusKind,
} from "./theme.ts";

/** 快照并恢复给定 env，避免污染其他测试（同 util/color_test.ts 做法）。 */
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

const CLEAN = { NO_COLOR: undefined, LOG_COLOR: undefined };

// ---------- 唯一判定路径：resolveColor 是唯一的开/关决策 ----------

Deno.test("theme: enabled 与 resolveColor(mode, stream) 逐格一致（无第二套判定）", () => {
  for (const logColor of [undefined, "always", "never"]) {
    for (const mode of COLOR_MODES) {
      for (const stream of ["stdout", "stderr"] as const) {
        withEnv({ NO_COLOR: undefined, LOG_COLOR: logColor }, () => {
          assertEquals(
            createTheme(mode, stream).enabled,
            resolveColor(mode, stream),
            `mode=${mode} stream=${stream} LOG_COLOR=${logColor}`,
          );
        });
      }
    }
  }
});

// ---------- 非 TTY / NO_COLOR：输出里绝不能有 ANSI 转义 ----------

Deno.test("theme: NO_COLOR 非空时无色，且字符串中不含 \x1b[", () => {
  withEnv({ NO_COLOR: "1", LOG_COLOR: undefined }, () => {
    const theme = createTheme("always");
    assertEquals(theme.enabled, false, "NO_COLOR 压过 --color=always");
    for (
      const kind of ["success", "warning", "error", "info"] as StatusKind[]
    ) {
      const s = theme.status(kind, "文本");
      assertEquals(s.includes("\x1b["), false, `NO_COLOR 仍带 ANSI: ${s}`);
      assertEquals(s, `${STATUS_SYMBOL[kind]} 文本`);
    }
    assertEquals(theme.color("primary", "品牌").includes("\x1b["), false);
  });
});

Deno.test("theme: --color=never 无色，字符串中不含 \x1b[", () => {
  withEnv(CLEAN, () => {
    const theme = createTheme("never");
    assertEquals(theme.enabled, false);
    const out = theme.status("error", "构建失败") +
      theme.color("muted", "（详见日志）");
    assertEquals(out.includes("\x1b["), false);
  });
});

Deno.test("theme: auto 且 stdout 非 TTY（重定向/管道）时无色", () => {
  // 测试进程 stdout 不是 TTY：等价于 `noj-cli status > out.txt`。
  withEnv(CLEAN, () => {
    const theme = createTheme("auto", "stdout");
    assertEquals(theme.enabled, false);
    assertEquals(theme.status("success", "全部通过").includes("\x1b["), false);
  });
});

// ---------- --color=always：确实着色 ----------

Deno.test("theme: --color=always 时语义色生效且只包住符号", () => {
  withEnv(CLEAN, () => {
    const theme = createTheme("always", "stdout");
    assertEquals(theme.enabled, true);
    const s = theme.status("success", "部署完成");
    // 符号被语义色包住，reset 紧邻符号——正文不被整行染色
    assertEquals(
      s,
      `${SEMANTIC_ANSI.success}${STATUS_SYMBOL.success}[0m 部署完成`,
    );
    assertEquals(s.includes("\x1b["), true);
  });
});

Deno.test("theme: color() 用 token 对应的 ANSI 码并闭合成 reset 片段", () => {
  withEnv(CLEAN, () => {
    const theme = createTheme("always", "stdout");
    for (
      const token of Object.keys(
        SEMANTIC_ANSI,
      ) as (keyof typeof SEMANTIC_ANSI)[]
    ) {
      assertEquals(theme.color(token, "x"), `${SEMANTIC_ANSI[token]}x[0m`);
    }
    // 空串不产生孤立转义（无内容可着色）
    assertEquals(theme.color("primary", ""), "");
    assertEquals(theme.color("primary", "").includes("\x1b["), false);
  });
});

Deno.test("theme: LOG_COLOR=always 覆盖 auto（既有契约回归）", () => {
  withEnv({ NO_COLOR: undefined, LOG_COLOR: "always" }, () => {
    assertEquals(createTheme("auto", "stdout").enabled, true);
  });
});

// ---------- 符号与 token 映射 ----------

Deno.test("theme: 四种状态各有符号，且成功/警告/错误三色互不相同", () => {
  assertEquals(STATUS_SYMBOL.success, "✓");
  assertEquals(STATUS_SYMBOL.warning, "!");
  assertEquals(STATUS_SYMBOL.error, "✗");
  assertEquals(STATUS_SYMBOL.info, "ℹ");
  const three = new Set([
    SEMANTIC_ANSI.success,
    SEMANTIC_ANSI.warning,
    SEMANTIC_ANSI.error,
  ]);
  assertEquals(three.size, 3, "成功/警告/错误必须是三种可用肉眼区分的色调");
});

Deno.test("theme: 语义 token 名与设计 Token 文档一一对应", () => {
  assertEquals(SEMANTIC_TOKEN_NAMES.success, "--c-success-text");
  assertEquals(SEMANTIC_TOKEN_NAMES.warning, "--c-warning-text");
  assertEquals(SEMANTIC_TOKEN_NAMES.error, "--c-error-text");
  assertEquals(SEMANTIC_TOKEN_NAMES.info, "--c-info-text");
  assertEquals(SEMANTIC_TOKEN_NAMES.primary, "--c-primary");
  assertEquals(SEMANTIC_TOKEN_NAMES.signal, "--c-signal");
  assertEquals(SEMANTIC_TOKEN_NAMES.muted, "--c-text-muted");
  assertEquals(SEMANTIC_TOKEN_NAMES.secondary, "--c-text-secondary");
});

Deno.test("theme: 所有 ANSI 码都是合法 SGR 前景/样式序列", () => {
  for (
    const [token, ansi] of Object.entries(SEMANTIC_ANSI) as [string, string][]
  ) {
    // 不写含 \x1b 的正则：SGR 序列 = ESC '[' 数字 'm'
    const body = ansi.slice(2, -1);
    assertEquals(ansi.startsWith("\x1b["), true, `${token} 缺少 ESC[: ${ansi}`);
    assertEquals(ansi.endsWith("m"), true, `${token} 缺少 m: ${ansi}`);
    assertEquals(
      /^[0-9]+$/.test(body),
      true,
      `${token} SGR 参数非数字: ${ansi}`,
    );
  }
});

Deno.test("theme: ColorMode 全成员在两种流上都不抛错（防御性）", () => {
  for (const mode of COLOR_MODES as readonly ColorMode[]) {
    for (const stream of ["stdout", "stderr"] as const) {
      withEnv(CLEAN, () => {
        const theme = createTheme(mode, stream);
        assertEquals(typeof theme.enabled, "boolean");
        assertEquals(theme.symbol("info"), STATUS_SYMBOL.info);
      });
    }
  }
});
