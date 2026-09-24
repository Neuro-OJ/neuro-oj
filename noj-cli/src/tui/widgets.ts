import type { PromptIO } from "./io.ts";

/** {@link select} 的选项。 */
export interface SelectOptions {
  /**
   * 视为"回退"的输入（T22）。命中时**立即返回 -1** 而不重试。
   *
   * 为什么需要它：`problem init` 的引导要求"含校验与回退"（R6）。回退必须是
   * `select` 能表达的结果，否则调用方只能靠"抛异常"来中断选择——那会让
   * "回退"与"出错"在调用方无法区分。
   *
   * 缺省为空（沿用"非法输入一律重试"的既有语义，不改变既有调用方行为）。
   */
  backWords?: readonly string[];
  /**
   * `select` 自身的重试上限（缺省无上限，沿用既有语义）。
   *
   * 引导层另有自己的字段级上限；这里提供上限是为了让"输入已结束"（`readLine`
   * 恒返回空串）时**不挂死**——EOF 下空串既不匹配编号也不是回退词，无上限就会
   * 无限重问。
   */
  maxAttempts?: number;
  /**
   * 空输入（直接回车）时接受的下标（缺省 `undefined` = 回车视为非法并重试）。
   *
   * 这是既有引导期望的 UX："回车接受默认项"（`problem init` 的归属/难度均如此）。
   * 不提供它就等于把"回车"当成错误——在 EOF 下（`readLine` 恒返回空串）更会
   * **无限重问**，那是实测踩到的挂死路径。
   */
  defaultIndex?: number;
}

/**
 * 打印编号选项并让用户选择，返回选中下标（0-based）。
 *
 * 非法输入重试；命中 `backWords` 时返回 **-1**；给 `maxAttempts` 时超限抛错
 * （缺省不设上限，保持既有行为不变）。
 */
export async function select(
  io: PromptIO,
  question: string,
  options: string[],
  opts: SelectOptions = {},
): Promise<number> {
  let attempts = 0;
  while (true) {
    if (opts.maxAttempts !== undefined && ++attempts > opts.maxAttempts) {
      throw new Error(
        `选择「${question}」超过 ${opts.maxAttempts} 次仍未获得有效输入`,
      );
    }
    io.write(`${question}\n`);
    options.forEach((opt, i) => io.write(`  ${i + 1}) ${opt}\n`));
    const raw = (await io.readLine("请输入编号: ")).trim();
    if (
      opts.backWords !== undefined && opts.backWords.includes(raw.toLowerCase())
    ) {
      return -1;
    }
    // 回车 = 接受默认项（既有 UX；也让 EOF 下的空串有确定的落点而非无限重试）
    if (raw === "" && opts.defaultIndex !== undefined) {
      return opts.defaultIndex;
    }
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      return n - 1;
    }
    io.write("输入无效，请重新选择。\n");
  }
}

/** 文本输入；空输入返回默认值。 */
export async function input(
  io: PromptIO,
  question: string,
  def?: string,
): Promise<string> {
  const suffix = def === undefined ? "" : ` [${def}]`;
  const raw = await io.readLine(`${question}${suffix}: `);
  return raw === "" ? (def ?? "") : raw;
}

/** 敏感输入；空输入重试。 */
export async function secretInput(
  io: PromptIO,
  question: string,
): Promise<string> {
  while (true) {
    const raw = await io.readSecret(`${question}: `);
    if (raw !== "") return raw;
    io.write("输入不能为空，请重试。\n");
  }
}

/** 确认；y/n，空输入返回默认值。 */
export async function confirm(
  io: PromptIO,
  question: string,
  def?: boolean,
): Promise<boolean> {
  const suffix = def === undefined ? " (y/n)" : def ? " (Y/n)" : " (y/N)";
  while (true) {
    const raw = (await io.readLine(`${question}${suffix}: `)).toLowerCase();
    if (raw === "y") return true;
    if (raw === "n") return false;
    if (raw === "" && def !== undefined) return def;
    io.write("请输入 y 或 n。\n");
  }
}
