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
