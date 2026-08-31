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

/** 给一行日志加彩色模块前缀；line 末尾换行会被去掉。 */
export function prefixLine(
  module: string,
  line: string,
  color: string,
): string {
  const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
  return `${color}[${module}] ${trimmed}${RESET}`;
}
