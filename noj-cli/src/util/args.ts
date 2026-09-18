/**
 * CLI 参数解析与诊断的共用工具。
 *
 * 抽出原因（#517 E6/E8）：`--dir` 曾在 4 处各自手写解析且行为不一致——
 * `parseProductionArgs` 支持 `--dir=` 且缺值报错，而 `parseDeployArgs` /
 * `parseMaintainArgs` / `parseBackupArgs` 不支持 `--dir=` 且缺值静默取到
 * `undefined`。用户传了参数却没生效，且没有任何提示。
 */

/** 用法错误（参数非法、缺少必需参数）：对应退出码 2，与运行失败（1）区分。 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * 解析 `--dir <path>` / `--dir=<path>`，两者等价。
 *
 * 缺值（`--dir` 在末尾、`--dir=` 空值、或后面紧跟另一个选项）抛
 * {@link UsageError}，**不再静默返回 undefined**。
 *
 * @returns 目录值；未出现 `--dir` 时返回 undefined。
 */
export function parseDirArg(args: string[]): string | undefined {
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dir") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError("--dir 需要一个安装目录");
      }
      dir = value;
      i++;
    } else if (arg.startsWith("--dir=")) {
      const value = arg.slice("--dir=".length);
      if (value === "") {
        throw new UsageError("--dir 需要一个安装目录");
      }
      dir = value;
    }
  }
  return dir;
}

/**
 * 计算 Levenshtein 编辑距离（用于「你是否想执行 X」的建议）。
 *
 * 经典滚动数组实现，O(min(a,b)) 额外空间。
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1, // 删除
        curr[j - 1]! + 1, // 插入
        prev[j - 1]! + cost, // 替换
      );
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/**
 * 为无法识别的命令给出最接近的已知命令。
 *
 * 阈值按输入长度自适应：太短的输入（如 `x`）要求完全匹配，
 * 避免「距离 1」把任意单字符映射到某个命令而产生误导性建议。
 *
 * @returns 建议命令；没有足够接近的候选时返回 undefined（调用方给通用提示）。
 */
export function suggestCommand(
  input: string,
  known: Iterable<string>,
): string | undefined {
  const trimmed = input.trim();
  const needle = trimmed.toLowerCase();
  if (needle === "") return undefined;

  // 短输入要求距离 0（即必须完全一致），长输入允许 1~2 的笔误
  const maxDistance = needle.length <= 2 ? 0 : needle.length <= 4 ? 1 : 2;

  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    // 绝不把**完全相同的输入**当作建议（否则会出现
    // 「未知命令: X；你是否想执行: X？」）
    if (candidate === trimmed) continue;
    const distance = levenshtein(needle, candidate.toLowerCase());
    if (distance <= maxDistance && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** 解析 `--port <n>`，校验 1-65535；非法值与缺值均抛 {@link UsageError}。 */
export function parsePortArg(
  args: string[],
  fallback: number,
): number {
  const idx = args.indexOf("--port");
  if (idx === -1) return fallback;
  const raw = args[idx + 1];
  return validatePort(raw);
}

/** 校验端口字符串；错误信息包含实际收到的值，便于用户定位。 */
export function validatePort(raw: unknown): number {
  if (raw === undefined || raw === "") {
    throw new UsageError("--port 需要一个 1-65535 的整数");
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new UsageError(`--port 需要一个 1-65535 的整数，收到 "${raw}"`);
  }
  return n;
}
