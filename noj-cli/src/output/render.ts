/**
 * 输出通道硬化（spec R5）：`--json` 的 stdout 必须**逐字节为合法 JSON**。
 *
 * 设计要点——**不持有任何模块级可变状态**：
 * 1. JSON 模式由调用方传入（`io.jsonMode`）/ 由 `isJsonMode` 从参数现场推导，
 *    本模块不记忆"当前是不是 JSON 模式"。
 * 2. 真实流是**每次调用现算**的默认值，而非惰性初始化的模块级单例；
 *    测试注入的 `io` 也不写入任何全局。
 *
 * 这样就不触碰 AGENTS.md §8.2 的多副本约束（该约束针对进程内可变状态：
 * 缓存/计数器/去重标记）。本模块除函数声明外不持有任何模块级绑定，
 * 更没有可写的跨调用状态。
 *
 * 未接入本模块前，`maintain/drill.ts:302-321` 已有"捕获子进程 stdout 转写
 * stderr"的临时做法；本模块把这套规则收敛为**唯一共享原语**，供命令树与
 * 列表类命令复用，避免各自再解一遍。
 */

import type { ColorMode } from "../util/color.ts";
import { createTheme, STATUS_SYMBOL, type StatusKind } from "./theme.ts";

/** 输出汇聚点：测试用它捕获，生产环境缺省直达真实进程流。 */
export interface RenderIO {
  /** stdout 汇聚点；缺省直达 `Deno.stdout`。 */
  stdout?: (s: string) => void;
  /**
   * stderr 汇聚点；缺省直达 `Deno.stderr`。
   *
   * brief 的签名只写了 `stdout`，这里**追加**该可选字段：JSON 模式下
   * `emitHuman` 的改道目标必须可观测，否则"未污染 stdout"只测了一半
   * （人类文本究竟去了哪里无从断言）。传入 `{ stdout }` 仍完全兼容。
   */
  stderr?: (s: string) => void;
  /**
   * 是否处于 JSON 模式。
   *
   * 由调用方传入而非本模块记忆——正是为了不引入模块级可变状态。
   * 缺省 `false`（人类可读输出）。
   */
  jsonMode?: boolean;
}

/** 真实 stdout 写入：每次现算，避免模块级可变单例。 */
function writeStdout(s: string): void {
  Deno.stdout.writeSync(new TextEncoder().encode(s));
}

/** 真实 stderr 写入：每次现算，避免模块级可变单例。 */
function writeStderr(s: string): void {
  Deno.stderr.writeSync(new TextEncoder().encode(s));
}

/**
 * 把值作为**唯一**的 stdout 内容写出：`JSON.stringify(value, null, 2)` + 一个换行。
 *
 * 不着色、不加前缀、不夹带人类文本，也不写 stderr——这是 `--json | jq` 的硬约束。
 * `JSON.stringify` 对 `undefined`（含函数、Symbol 等不可序列化值）返回
 * `undefined`，此时退化为字面量 `null`，保证 stdout 仍是合法 JSON。
 */
export function emitJson(value: unknown, io?: RenderIO): void {
  const sink = io?.stdout ?? writeStdout;
  sink((JSON.stringify(value, null, 2) ?? "null") + "\n");
}

/**
 * 写出人类可读文本：**非 JSON 模式写 stdout，JSON 模式改道 stderr**。
 *
 * 于是同一条命令可以既打日志又打 `--json` 报告，而机器通道不被污染
 * （与 `maintain/drill.ts` 既有做法同一语义）。
 */
export function emitHuman(text: string, io?: RenderIO): void {
  const jsonMode = io?.jsonMode === true;
  const sink = jsonMode
    ? (io?.stderr ?? writeStderr)
    : (io?.stdout ?? writeStdout);
  sink(text);
}

/**
 * 从参数数组判定是否开启 JSON 模式：只认**独立 token** `--json`。
 *
 * `--json=true` / `--json=false` **不支持**：本仓 `--json` 历来是裸旗标
 * （`cli.ts` 的 `case "--json": out.json = true`），发明 `=值` 形式会引入
 * 「`--json=false` 反而开启机器输出」这类静默误判；`--jsonx`、`-j`、
 * `--JSON` 同样不算命中（大小写敏感、非前缀匹配）。
 */
export function isJsonMode(args: string[]): boolean {
  return args.includes("--json");
}

// ---------- Task 8：品牌排版（语义色 / 状态符号 / 表格） ----------
//
// 本节只做**人类可读输出**的排版，且必须沿用 T6 的通道契约：
// 所有写出都经 `emitHuman`，于是 `--json` 模式下表格/状态自动改道 stderr，
// stdout 仍逐字节为 JSON。空表在**任何**模式下都不写任何流。

/**
 * 匹配 SGR 转义序列；宽度计算与截断前先剥离，避免把转义码算成可见列。
 *
 * 匹配 ANSI 转义天然需要 ESC(\x1b) 控制字符，故显式豁免 lint 规则。
 */
// deno-lint-ignore no-control-regex
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/** 单个码点是否为 East Asian Wide / Fullwidth（终端占 2 列）。 */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 韩文字母
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首与符号（`。` U+3002 在内）
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名 / CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII（`，` `！` 在内）
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B 及以上（代理对）
  );
}

/** 单个码点的显示列数：组合记号/变体选择符/控制符 0 列，CJK 全角 2 列，其余 1 列。 */
function codePointWidth(cp: number): number {
  // 组合变音符、零宽连接符、变体选择符不占列。
  if (
    cp === 0x200d ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  ) {
    return 0;
  }
  // 控制字符（含换行）不占列；调用方已先按 \n 切分。
  if (cp < 0x20 || cp === 0x7f) return 0;
  return isWideCodePoint(cp) ? 2 : 1;
}

/**
 * 终端显示宽度（列数）：CJK 全角字符按 2 列计，ANSI 转义不占列。
 *
 * 用于表格对齐与宽度约束。终端没有字体度量，这是终端世界的"字符串长度"；
 * 用 `String.length`（UTF-16 码元）对齐会让中文表格整体错位。
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text.replace(ANSI_SGR_RE, "")) {
    width += codePointWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
}

/** 按显示宽度截断，超宽时以 `…` 标记（保证结果 ≤ width）。 */
function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  const clean = text.replace(ANSI_SGR_RE, "");
  const target = width - 1; // 留 1 列给省略号
  let out = "";
  let used = 0;
  for (const ch of clean) {
    const cw = codePointWidth(ch.codePointAt(0) ?? 0);
    if (used + cw > target) break;
    out += ch;
    used += cw;
  }
  return out + "…";
}

/** 按显示宽度右侧补空格（超出时原样返回，绝不产生超宽行）。 */
function padToWidth(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/** 列间距（固定 2 列）。 */
const COLUMN_GAP = "  ";

/**
 * 分配各列渲染宽度：在 `maxWidth` 约束内尽量保留自然宽。
 *
 * 规则（与设计 Token 文档「排版」一致）：
 * 1. 列间距固定 `2*(n-1)`，从预算里先扣掉；
 * 2. 预算 ≥ 列数时，轮流从**当前最宽**的列扣 1（不低于 1），使收缩均匀；
 * 3. 预算 < 列数（极窄终端）时每列保底 1 列，允许布局本身超宽——
 *    调用方随后对整行硬截断，最终仍保证 ≤ maxWidth。
 */
function fitColumnWidths(
  natural: readonly number[],
  maxWidth: number,
): number[] {
  const count = natural.length;
  const budget = maxWidth - COLUMN_GAP.length * (count - 1);
  const cols = natural.map((w) => Math.max(1, w));
  if (budget < count) return cols;
  let total = cols.reduce((a, b) => a + b, 0);
  while (total > budget) {
    let widest = 0;
    for (let i = 1; i < count; i++) {
      if (cols[i]! > cols[widest]!) widest = i;
    }
    if (cols[widest]! <= 1) break; // 已全部压到最窄
    cols[widest]!--;
    total--;
  }
  return cols;
}

/** `renderTable` 的选项。 */
export interface TableOptions {
  /**
   * 最大总显示宽度（列数）。给定后**每一行**的显示宽度都 ≤ 该值：
   * 先均匀收缩最宽列，超宽单元格以 `…` 截断；极窄时再对整行硬截断。
   * 省略则按内容自然宽渲染。
   */
  maxWidth?: number;
  /**
   * 输出汇聚点；`jsonMode: true` 时表格改道 stderr（表格是人类输出，
   * 不得污染 `--json` 的 stdout）。
   */
  io?: RenderIO;
}

/**
 * 渲染一张对齐到显示宽度的表格。
 *
 * - 列对齐：每列补齐到该列最宽单元格的显示宽度（**CJK 全角按 2 列计**，
 *   含中文、日文、韩文、全角标点、CJK 扩展 B 及以上的代理对）；
 * - 宽度约束：`maxWidth` 下每一行显示宽度都 ≤ 该值——先均摊收缩最宽列，
 *   超宽单元格以 `…` 截断，极窄（预算 < 列数）时再整行硬截断兜底；
 * - 已知边界（诚实声明）：East Asian **Ambiguous**（如 `─` U+2500、`±`）
 *   与 emoji 未按 2 列计（emoji 多属 Wide，但 ZWJ 序列的合成宽度取决于
 *   终端字体）；本实现的表格分隔线一律用 ASCII `-` 规避 Ambiguous 歧义；
 * - 单元格内的 `\n` 展开为多行，同一逻辑行内各列按行号配对；
 * - 行尾含填充空格（便于逐行比较总宽），整表以恰好一个换行结尾；
 * - **空表**（无行、或所有行都是空数组）返回 `""` 且不写任何流；
 * - 返回渲染文本，同时经 `emitHuman` 写往 stdout（JSON 模式为 stderr）。
 */
export function renderTable(
  rows: readonly (readonly string[])[],
  opts: TableOptions = {},
): string {
  const columnCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (columnCount === 0) return ""; // 空表：不抛错、不写流
  // 展开单元格内换行为物理行；缺列补空串（行长不齐不抛错）。
  const physical: string[][] = [];
  for (const row of rows) {
    const cells = Array.from(
      { length: columnCount },
      (_, i) => String(row[i] ?? "").split("\n"),
    );
    const height = Math.max(1, ...cells.map((c) => c.length));
    for (let line = 0; line < height; line++) {
      physical.push(cells.map((c) => c[line] ?? ""));
    }
  }
  const natural = Array.from(
    { length: columnCount },
    (_, i) =>
      physical.reduce((m, r) => Math.max(m, displayWidth(r[i] ?? "")), 0),
  );
  const { maxWidth } = opts;
  const cols = maxWidth === undefined
    ? natural.map((w) => Math.max(1, w))
    : fitColumnWidths(natural, maxWidth);
  let lines = physical.map((cells) =>
    cells.map((cell, i) =>
      padToWidth(truncateToWidth(cell, cols[i]!), cols[i]!)
    ).join(COLUMN_GAP)
  );
  if (maxWidth !== undefined) {
    // 极窄布局（每列保底 1 列仍超宽）的最后一道闸：整行硬截断。
    lines = lines.map((line) => truncateToWidth(line, maxWidth));
  }
  const text = lines.join("\n") + "\n";
  emitHuman(text, opts.io);
  return text;
}

/** `renderStatus` 的选项。 */
export interface StatusOptions {
  /** 颜色模式（`--color`）；默认 `auto`。 */
  color?: ColorMode;
  /** 目标流；决定 `auto` 模式的 TTY 探测与主题开关。默认 stdout。 */
  stream?: "stdout" | "stderr";
  /** 输出汇聚点；`jsonMode: true` 时状态行改道 stderr。 */
  io?: RenderIO;
}

/**
 * 渲染一行状态：语义色符号 + 文本。
 *
 * 符号与语义色配对（`✓` 成功 / `!` 警告 / `✗` 错误 / `ℹ` 信息），
 * 于是颜色关闭时（非 TTY / `NO_COLOR` / `--color=never`）**仅靠符号也能区分**，
 * 输出中不含任何 ANSI 转义。多行文本只在首行带符号，续行缩进 2 格对齐。
 * 写往 stdout（JSON 模式为 stderr，经 `emitHuman`）。
 *
 * 符号本身就是**宽字符**（`✓`/`✗`/`ℹ` 各占 2 列），故这里刻意用
 * `${`` 空格而非 `padEnd` 对齐：终端会按 2 列渲染符号，再做列宽
 * 计算反而会人为引入偏差。表格里的短状态列建议同样只放符号。
 */
export function renderStatus(
  kind: StatusKind,
  text: string,
  opts: StatusOptions = {},
): string {
  // 复用同一套主题/开关判定；不在此重复 NO_COLOR/TTY 判断。
  const theme = createTheme(opts.color ?? "auto", opts.stream ?? "stdout");
  const [first = "", ...rest] = text.split("\n");
  const out = [
    `${theme.color(kind, STATUS_SYMBOL[kind])} ${first}`,
    ...rest.map((line) => `  ${line}`),
  ].join("\n") + "\n";
  emitHuman(out, opts.io);
  return out;
}
