import type { PromptIO } from "./io.ts";

/** 打印编号选项并让用户选择，返回选中下标（0-based）。非法输入重试。 */
export async function select(
  io: PromptIO,
  question: string,
  options: string[],
): Promise<number> {
  while (true) {
    io.write(`${question}\n`);
    options.forEach((opt, i) => io.write(`  ${i + 1}) ${opt}\n`));
    const raw = await io.readLine("请输入编号: ");
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
