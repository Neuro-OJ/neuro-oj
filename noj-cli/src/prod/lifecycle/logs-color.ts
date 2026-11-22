/**
 * `logs` 的着色契约：NO_COLOR / FORCE_COLOR / TTY 的合并与决策。
 *
 * logs 有一套**明确**的着色优先级：早先无条件透传，导致 `noj-cli logs core > out.txt` 把 docker compose 的 ANSI 转义码写进重定向
 * 文件。本节把该契约收敛为三个纯函数，**不新增第二套** `NO_COLOR`/`LOG_COLOR`
 * 解析：取值合并在上层，最终开/关判定仍交回 `util/color.ts:resolveColor`。
 */

import { type ColorMode, resolveColor } from "../../util/color.ts";

/**
 * 合并着色来源：**进程环境优先（非空即胜出），否则回退 `.env.prod`**。
 *
 * 注意判定用的是**未 trim** 的原始值：进程环境里的纯空白值会「占位」而不回退到
 * `.env.prod`。
 *
 * @param processValue 进程环境值（`undefined` = 未设置）
 * @param fileValue `.env.prod` 的值（`undefined` = 未设置）
 */
export function mergeColorSource(
    processValue: string | undefined,
    fileValue: string | undefined,
): string {
    if (processValue !== undefined && processValue !== "") return processValue;
    return fileValue ?? "";
}

/**
 * logs 的着色决策。
 *
 * - `"no-color"`：传 `--no-color`（`NO_COLOR` 非空 **或** `LOG_COLOR=never`，
 *   或回退分支判定为关）；
 * - `"force"`：传**全局** `--ansi always`（`LOG_COLOR=always`）；
 * - `"inherit"`：既不加 `--no-color` 也不强制——把着色交回 compose 自身探测
 *   （**不是**「开」：`docker compose logs` 没有单命令的强制开开关，见下）。
 */
export type LogsColorDecision = "no-color" | "force" | "inherit";

/**
 * {@link decideLogsColor} 的输入：两个已由 {@link mergeColorSource} 合并的原始值。
 *
 * **刻意不含 `--color`**：logs 的着色契约只有
 * `LOG_COLOR` / `NO_COLOR` / stdout TTY 三个输入；`--color` 只作用于本进程的
 * 人类输出主题（`lifecycleContext`），不参与 compose 色旗的推导。把 `--color`
 * 混进来会让 `--color=never` 压过 `LOG_COLOR=always`。
 */
export interface LogsColorOptions {
    /** 已合并的 `LOG_COLOR` 原始值（未 trim）。 */
    logColor?: string;
    /** 已合并的 `NO_COLOR` 原始值（未 trim）。 */
    noColor?: string;
    /** `resolveColor` 探测的流；缺省 stdout。 */
    stream?: "stdout" | "stderr";
}

/**
 * 判定 logs 的着色决策，分支顺序：
 *
 * 1. `NO_COLOR` 非空或 `LOG_COLOR=never` → `--no-color`；
 * 2. `LOG_COLOR=always` → 全局 `--ansi always`；
 * 3. stdout 非 TTY → `--no-color`。
 *
 * **分支 1 在前**：`NO_COLOR` 非空时即使 `LOG_COLOR=always` 也关色。`LOG_COLOR`
 * 大小写不敏感、首尾空白被归一（与 TS 侧既有的 trim+toLowerCase 一致）。
 *
 * 前两个分支是显式判定，命中即短路；**其余情况**（含 `LOG_COLOR` 未设置、
 * 取值无法识别）一律回退到 `resolveColor`——着色开/关的**唯一**判定源。因此
 * `--color=never` / `NO_COLOR` / 非 TTY 这三条既有规则不会在此漂移。
 */
export function decideLogsColor(
    options: LogsColorOptions = {},
): LogsColorDecision {
    const logColor = (options.logColor ?? "").trim().toLowerCase();

    // 把「合并后的有效 LOG_COLOR / NO_COLOR」翻译成 resolveColor 接受的 mode 入参：
    // - NO_COLOR 非空 **或** LOG_COLOR=never → `never`（分支 1；NO_COLOR 在前，
    //   即使 LOG_COLOR=always 也关）；
    // - LOG_COLOR=always → `always`（分支 2，强制）；
    // - 其余 → `auto`（分支 3 的 TTY 探测；resolveColor 内部再读进程 LOG_COLOR
    //   时与合并值一致，因为此时合并值本就来自进程环境或无法识别）。
    let mode: ColorMode = "auto";
    if ((options.noColor ?? "") !== "") mode = "never";
    else if (logColor === "never") mode = "never";
    else if (logColor === "always") mode = "always";

    // **唯一着色判定源**：stdout 非 TTY（重定向）→ false → --no-color，这正是
    // 「重定向不写 ANSI」的落点。
    if (!resolveColor(mode, options.stream ?? "stdout")) return "no-color";
    // 判为「开」时再区分语义：模式为 always（来自 LOG_COLOR=always）才是**强制**
    // （全局 --ansi always）；auto + TTY 只是把决定权交回 compose 自身探测。
    return mode === "always" ? "force" : "inherit";
}

/**
 * 把着色决策落到 `composeLogs` 产出的参数数组上。
 *
 * **强制着色必须用子命令之前的全局 `--ansi always`**：`docker compose logs`
 * 只有 `--no-color`，**没有**单命令的「强制开」开关——省略 `--no-color` 只是把
 * 决定权交回 compose 自己的 TTY 探测，并不等于「开」。`--ansi` 是全局旗标，必须排在子命令之前，故在
 * `logs` 之前插入，而不是追加到数组末尾。
 *
 * `no-color` 则插在 `--tail=200` / `--follow` 之后、位置参数（服务名）之前。
 *
 * 输入是 `composeLogs` 的 dryRun 结果，tail / follow / services 的相对顺序
 * 由它保证，这里只做两处插入，不重排任何既有元素。
 */
export function applyLogsColor(
    args: string[],
    decision: LogsColorDecision,
): string[] {
    const out = [...args];
    const sub = out.indexOf("logs");
    if (sub === -1) {
        throw new Error("compose 参数缺少 logs 子命令：" + args.join(" "));
    }
    if (decision === "force") {
        out.splice(sub, 0, "--ansi", "always");
        return out;
    }
    if (decision === "no-color") {
        // 跳过 logs 之后的旗标（--tail=200 / --follow），插在首个位置参数之前。
        let at = sub + 1;
        while (at < out.length && out[at]!.startsWith("--")) at++;
        out.splice(at, 0, "--no-color");
    }
    return out;
}
