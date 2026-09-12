/** ANSI 重置码。 */
export const RESET = "\x1b[0m";

/** 固定调色板：8 种可读 ANSI 前景色。 */
const PALETTE = [
  "\x1b[36m", // cyan
  "\x1b[32m", // green
  "\x1b[33m", // yellow
  "\x1b[35m", // magenta
  "\x1b[34m", // blue
  "\x1b[31m", // red
  "\x1b[96m", // bright cyan
  "\x1b[92m", // bright green
];

/** 简单字符串哈希（FNV-1a 32 位），用于稳定取色。 */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 按模块名稳定取一个 ANSI 前景色码。 */
export function colorFor(name: string): string {
  return PALETTE[hash(name) % PALETTE.length]!;
}

/** 着色模式（`--color` 的取值；默认 auto）。 */
export type ColorMode = "auto" | "always" | "never";

/**
 * 解析 `--color` 参数（大小写不敏感），非法值回退 auto。
 */
export function parseColorMode(arg: string | undefined): ColorMode {
  const raw = arg?.trim().toLowerCase();
  if (raw === "always" || raw === "never" || raw === "auto") return raw;
  return "auto";
}

/**
 * 判定某条输出流是否着色（视觉契约 §3）。
 *
 * 判定顺序：`NO_COLOR` 非空 → 关；`mode=never` → 关；`mode=always` → 开；
 * `mode=auto` 再看 `LOG_COLOR`（never/always），否则按流探测 TTY。
 *
 * 修复既有缺陷：`maintain logs` 原先**无条件**着色，
 * `noj-cli logs > out.txt` 会把 ANSI 转义码写进重定向文件。
 * 按流分别探测与 core / gateway / judge 保持同一契约。
 */
export function resolveColor(
  mode: ColorMode,
  stream: "stdout" | "stderr",
): boolean {
  const noColor = Deno.env.get("NO_COLOR");
  if (noColor !== undefined && noColor !== "") return false;
  if (mode === "never") return false;
  if (mode === "always") return true;
  const envMode = Deno.env.get("LOG_COLOR")?.trim().toLowerCase();
  if (envMode === "never") return false;
  if (envMode === "always") return true;
  try {
    return stream === "stderr"
      ? Deno.stderr.isTerminal()
      : Deno.stdout.isTerminal();
  } catch {
    return false; // 无 TTY 支持的环境保守关色
  }
}

/**
 * 给一行日志加彩色模块前缀；line 末尾换行会被去掉。
 *
 * `enabled=false` 时输出纯文本 `[module] line`（不含任何转义序列）。
 *
 * **只着色前缀本身**，不整行着色：
 * - 函数名与文档承诺的都是「彩色前缀」，整行染色是名实不符；
 * - `docker logs` / 文件里转发的行**自带 SGR**（core/gateway/judge 的 pretty
 *   输出），整行外侧的 `开 → 文本 → 关` 会被行内第一个 `reset` 清掉，于是
 *   「纯文本行整行染色、含 SGR 行只有前缀染色」——同一视图两种表现。
 */
export function prefixLine(
  module: string,
  line: string,
  color: string,
  enabled = true,
): string {
  const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
  const prefix = `[${module}]`;
  if (!enabled) return `${prefix} ${trimmed}`;
  // 前缀自成闭合片段，行体保持原样（含其自带样式）。
  return `${color}${prefix}${RESET} ${trimmed}`;
}
