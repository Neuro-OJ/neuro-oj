/**
 * CLI 参数解析与诊断的共用工具：旗标取值、用法错误与命令建议。
 *
 * 带值旗标一律经 {@link flagValue} 解析：`--flag v` 与 `--flag=v` 等价，缺值报
 * 用法错误而非静默取到 `undefined`（用户传了参数却没生效且没有任何提示）。
 */

/** 用法错误（参数非法、缺少必需参数）：对应退出码 2，与运行失败（1）区分。 */
export class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UsageError";
    }
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

/**
 * 取 `--flag value` 或 `--flag=value` 的值（首次出现）；未出现返回 undefined。
 *
 * 缺值（末尾、`--flag=` 空值、或后面紧跟另一个选项）抛 {@link UsageError}，
 * 文案可由 `missing` 覆盖。
 */
export function flagValue(
    args: string[],
    name: string,
    missing = `${name} 需要一个值`,
): string | undefined {
    const eq = `${name}=`;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === name) {
            const value = args[i + 1];
            if (value === undefined || value.startsWith("--")) {
                throw new UsageError(missing);
            }
            return value;
        }
        if (arg.startsWith(eq)) {
            const value = arg.slice(eq.length);
            if (value === "") throw new UsageError(missing);
            return value;
        }
    }
    return undefined;
}

/**
 * 读一个**非负整数**旗标；缺省返回 undefined，非法值抛用法错误。
 *
 * 存在的理由：这类值会被下游当作**数量/天数**参与"保护哪些备份"的计算，
 * 而非法的 `NaN` 在 `slice`/比较里会静默退化为"什么都不保护"——
 * 也就是说校验缺失的后果是**删数据**，不是报错。
 */
export function optionalCount(
    args: string[],
    name: string,
): number | undefined {
    const raw = flagValue(args, name);
    if (raw === undefined) return undefined;
    // 只接受十进制非负整数（拒绝 "1.5"、"1e3"、"0x10"、"-1"、""）
    if (!/^\d+$/.test(raw)) {
        throw new UsageError(`${name} 必须是非负整数，收到 "${raw}"`);
    }
    const n = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(n)) {
        throw new UsageError(`${name} 超出可用范围，收到 "${raw}"`);
    }
    return n;
}

/** 取布尔旗标（支持 `-y` 这类短名）。 */
export function hasFlag(args: string[], ...names: string[]): boolean {
    return args.some((a) => names.includes(a));
}
