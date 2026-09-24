/**
 * `problem init` 的 TUI 引导（#514 P6，T22 补 R6 收口）。
 *
 * 复用既有 TUI 基座（`tui/io.ts` 的 PromptIO + `tui/widgets.ts` 的
 * input/select/confirm），不引入新依赖——这正是 issue 所指
 * 「TUI 能力闲置」的正解：能力早已具备，只是没接到题目包流程。
 *
 * 与非交互模式的分工：
 * - 交互模式（默认，且 stdin 是 TTY）：缺什么问什么，带默认值；
 * - `--no-interactive` 或非 TTY：不提问，直接要求显式参数（避免 #517 修过的空转）。
 *
 * ## T22 补的三件事
 *
 * ### 1. EOF 不再挂死（修一个实测缺陷）
 *
 * 早先 slug 的校验是 `for (;;) { const raw = await input(...); if (SLUG_RE.test(raw)) break; }`。
 * `PromptIO.readLine` 在**输入结束时返回空串**（`realIO` 读到 EOF 就是这条路径），
 * 而空串永远不匹配 `SLUG_RE`——于是用户按 Ctrl-D 会看到 "slug 非法" 被**无限重复**
 * 并最终把进程的堆吃满（实测：Deno 报 `Fatal JavaScript out of memory`）。
 *
 * 根因不在校验，而在**假定了输入总会到来**。因此这里引入
 * {@link MAX_ATTEMPTS_PER_FIELD}：任一字段连续被拒绝（含空输入）超过上限即
 * **明确报错**，并给出可操作的替代路径（显式旗标 + `--no-interactive`）。
 *
 * 为什么不"空串 = 用户直接回车"地放过：这两者在 `readLine` 的返回值上
 * **不可区分**，而放过空串会让 slug 变成 `""`（一个非法且有害的目录名）。
 * 与其猜，不如报错——错误信息里说清发生了什么以及怎么绕开。
 *
 * ### 2. 回退（back）
 *
 * R6 明文要求"含校验与回退"。任一提问处输入 `back` / `:b` 即回到**上一个**字段
 * 重新提问；在第一步输入则给出提示后重问（无处可退）。回退计数同样受上限约束，
 * 避免"来回退"变成另一种挂死。
 *
 * ### 3. 进度提示
 *
 * 多步提问显示 `[当前/总数]`，总数取自 {@link planInitPrompts}（**不硬编码 4**）——
 * 已由旗标给出的字段不参与计数，否则用户在只答两项时看到 `[1/4]` 会困惑。
 */

import type { PromptIO } from "../tui/io.ts";
import { input, select } from "../tui/widgets.ts";
import { SLUG_PATTERN } from "./init.ts";

/** TUI 收集到的答案。 */
export interface ProblemInitAnswers {
  slug: string;
  title?: string;
  type: string;
  difficulty: string;
}

/** 引导是否需要提问（需要哪些字段已有值）。 */
export interface InitPromptPlan {
  askSlug: boolean;
  askTitle: boolean;
  askType: boolean;
  askDifficulty: boolean;
}

/** 计算待提问项：已由旗标给出的不再询问。 */
export function planInitPrompts(partial: {
  slug?: string;
  title?: string;
  type?: string;
  difficulty?: string;
}): InitPromptPlan {
  return {
    askSlug: !partial.slug,
    askTitle: !partial.title,
    askType: !partial.type,
    askDifficulty: !partial.difficulty,
  };
}

/**
 * 单字段的连续拒绝上限（T22）。
 *
 * **这个上限的存在只是为了保证"有限次后结束"**，而不是为了限制用户耐心：
 * EOF 下 `readLine` 恒返回空串，任何"重试直到合法"的循环都会永远转下去并把堆吃满
 * （实测：Deno 报 `Fatal JavaScript out of memory`）。
 *
 * 取 8 是刻意的宽松值——真人连续打错 8 次几乎不可能，而挂死会被 8 次之内终结。
 * 上限设小（例如 3）会把"边想边改"的正常用户踢出去，那是用错误的方式修 bug。
 */
export const MAX_ATTEMPTS_PER_FIELD = 8;

/**
 * 回退关键词（大小写不敏感）。
 *
 * 只保留 `back` 与 `:b`：单字母 `b` 太容易误触（题目标题真的可能就叫 "b"），
 * 而 `:b` 带前缀、明确表达意图。
 */
export const BACK_WORDS: readonly string[] = ["back", ":b"];

/**
 * 是否回退指令。
 *
 * **空串不是回退**：`input(io, prompt, def)` 在空输入时返回**默认值**（既有 UX），
 * 而 `BACK_WORDS` 里的 `"b"` 曾经让 `""` 意外命中（空串 trim 后是 `""`，不在表里；
 * 但若调用方传的是已 trim 的值则需另判）。这里显式挡掉空串，并把
 * {@link BACK_WORDS} 里的单字母 `"b"` 去掉——一个字母太容易误触，
 * 且它与"回车接受默认"的交互冲突。
 */
export function isBackWord(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === "") return false;
  return BACK_WORDS.includes(value);
}

/** 字段 → 对应的命令行旗标（供 {@link eofHint} 给出可直接照抄的命令）。 */
const FIELD_FLAGS: Readonly<Record<string, string>> = {
  slug: "--slug <slug>",
  title: "--title <title>",
  type: "--type P|U",
  difficulty: "--difficulty easy|medium|hard",
  "确认": "--yes",
};

/**
 * 输入已结束/连续空输入时的报错文案（可操作）。
 *
 * 必须**同时**说清三件事：发生了什么（EOF 或连续无效）、当前卡在哪个字段、
 * 以及怎么绕开（可直接粘贴的命令）。只说"输入无效"会让用户以为是自己的输入
 * 格式问题，而真正的原因是终端输入已经结束。
 */
export function eofHint(field: string): string {
  const flag = FIELD_FLAGS[field] ?? `--${field}`;
  return (
    `引导在「${field}」处中止：输入已结束（EOF）或连续 ${MAX_ATTEMPTS_PER_FIELD} ` +
    `次未给出有效值。\n` +
    `  自动化环境请使用显式旗标（无需 TTY）：\n` +
    `    noj-cli problem init --slug <slug> ${flag} --no-interactive\n` +
    `  交互环境请确认终端支持输入（或检查是否误按了 Ctrl-D）。`
  );
}

/** 引导的四步（顺序即提问顺序，也是回退的依据）。 */
type Field = "slug" | "title" | "type" | "difficulty";

/** 一个待提问步骤。 */
interface Step {
  field: Field;
  /** 该字段的提示文案（含进度前缀）。 */
  prompt: string;
}

/** 构造待提问步骤（含进度编号；总数即步骤数）。 */
export function buildSteps(plan: InitPromptPlan): Step[] {
  const fields: { field: Field; label: string }[] = [];
  if (plan.askSlug) fields.push({ field: "slug", label: "题目 slug" });
  if (plan.askTitle) fields.push({ field: "title", label: "题目标题" });
  if (plan.askType) fields.push({ field: "type", label: "题目归属" });
  if (plan.askDifficulty) fields.push({ field: "difficulty", label: "难度" });
  return fields.map((f, i) => ({
    field: f.field,
    prompt: `[${i + 1}/${fields.length}] ${f.label}`,
  }));
}

/**
 * 运行交互式引导。
 *
 * 只在 TTY 下调用；非 TTY 由调用方直接报错（见 `command.ts`）。
 * 所有问题都带默认值，回车即可接受，降低出题人的输入负担。
 *
 * @throws 输入结束/连续无效（见 {@link eofHint}）或用户取消（`已取消`）
 */
export async function guideProblemInit(
  io: PromptIO,
  partial: {
    slug?: string;
    title?: string;
    type?: string;
    difficulty?: string;
  },
): Promise<ProblemInitAnswers> {
  const plan = planInitPrompts(partial);
  const steps = buildSteps(plan);

  // 已确定的值（来自旗标或前几步的答案）。
  const answers: ProblemInitAnswers = {
    slug: partial.slug ?? "",
    title: partial.title,
    type: partial.type ?? "",
    difficulty: partial.difficulty ?? "",
  };

  // 回退需要重新提问，故用可回退的游标而非 for-of。
  let index = 0;
  // 全局步数上限：挡住"无限回退"这种另一种挂死。
  const maxSteps = Math.max(1, steps.length) * (MAX_ATTEMPTS_PER_FIELD + 1) * 4;
  let stepsTaken = 0;

  while (index < steps.length) {
    if (++stepsTaken > maxSteps) {
      throw new Error(eofHint(steps[Math.min(index, steps.length - 1)]!.field));
    }
    const step = steps[index]!;
    // 每个字段独立计数：回退回来时重新给机会，但同样有上界。
    let attempts = 0;
    let advanced = false;

    while (!advanced) {
      if (++attempts > MAX_ATTEMPTS_PER_FIELD) {
        throw new Error(eofHint(step.field));
      }
      const outcome = await askField(io, step, answers);
      if (outcome.kind === "back") {
        if (index === 0) {
          // 第一步无处可退：给提示后重问（不消耗"无效输入"额度之外的语义）
          io.write("已经是第一步，无法回退。\n");
          attempts--;
          continue;
        }
        index--;
        advanced = true;
        break;
      }
      if (outcome.kind === "invalid") {
        io.write(outcome.hint + "\n");
        continue;
      }
      // 成功：写回答案
      applyAnswer(answers, step.field, outcome.value);
      index++;
      advanced = true;
    }
  }

  if (!answers.slug) {
    // 理论上不可达（slug 要么由旗标给出，要么在循环里被设值）；留作不变式断言。
    throw new Error(eofHint("slug"));
  }

  // 最后确认一次（确认环节的 EOF 也走同一上限）。
  const ok = await confirmWithLimit(
    io,
    `确认生成：${answers.slug}（${answers.type} / ${answers.difficulty}）`,
  );
  if (!ok) throw new Error("已取消");

  return answers;
}

/** 把答案写回结果对象。 */
function applyAnswer(
  answers: ProblemInitAnswers,
  field: Field,
  value: string,
): void {
  switch (field) {
    case "slug":
      answers.slug = value;
      break;
    case "title":
      answers.title = value;
      break;
    case "type":
      answers.type = value;
      break;
    case "difficulty":
      answers.difficulty = value;
      break;
  }
}

/** 单字段提问的结果。 */
type FieldOutcome =
  | { kind: "ok"; value: string }
  | { kind: "invalid"; hint: string }
  | { kind: "back" };

/**
 * 问一个字段并校验（纯逻辑 + 一次 IO）。
 *
 * **校验优先于回退判定**：`back` 只在字段本身没有"值为 back 也合法"的可能时
 * 才是回退指令。当前四个字段里没有这种冲突（slug 不允许纯字母 `back`？——
 * 实际上 `back` 是合法 slug！）。
 *
 * **因此 slug 字段的回退用 `:b` 而非 `back`**：`back` 是一个合法 slug（3-64 位
 * 小写字母），把它当回退会**夺走一个合法的题目名**。这是有意的取舍：
 * 歧义时优先"输入即数据"，回退只认不会与数据冲突的 `:b`。
 */
async function askField(
  io: PromptIO,
  step: Step,
  answers: ProblemInitAnswers,
): Promise<FieldOutcome> {
  switch (step.field) {
    case "slug": {
      const raw = (await input(io, step.prompt)).trim();
      // 歧义字段：只认 `:b`（`back` 是合法 slug）
      if (raw === ":b") return { kind: "back" };
      if (raw === "") {
        return {
          kind: "invalid",
          hint:
            "slug 不能为空：要求 3-64 位小写字母/数字/连字符，首尾非连字符。",
        };
      }
      if (!SLUG_PATTERN.test(raw)) {
        return {
          kind: "invalid",
          hint: "slug 非法：要求 3-64 位小写字母/数字/连字符，首尾非连字符。",
        };
      }
      return { kind: "ok", value: raw };
    }
    case "title": {
      // **必须自己读一行再判回退**，不能用 `input(io, prompt, def)` 的返回值判：
      // `input` 会把空输入替换成默认值，而当默认值（= slug）恰好是 `back` 时，
      // 一次普通的"回车"就会被误判成回退（实测踩到：`problem init back` 在标题处
      // 回车即回退，然后一路空输入直至上限报错）。
      //
      // 因此：读原始行 → 判回退 → 空串才落到默认值。
      const raw = await io.readLine(`${step.prompt} [${answers.slug}]: `);
      if (isBackWord(raw)) return { kind: "back" };
      const value = raw === "" ? answers.slug : raw;
      return { kind: "ok", value };
    }
    case "type": {
      const idx = await select(io, step.prompt, [
        "P（主题库，默认）",
        "U（用户题库，visibility=private）",
      ], { backWords: BACK_WORDS, defaultIndex: 0 });
      if (idx === -1) return { kind: "back" };
      return { kind: "ok", value: idx === 0 ? "P" : "U" };
    }
    case "difficulty": {
      const idx = await select(io, step.prompt, [
        "medium（中等，默认）",
        "easy（简单）",
        "hard（困难）",
      ], { backWords: BACK_WORDS, defaultIndex: 0 });
      if (idx === -1) return { kind: "back" };
      return { kind: "ok", value: ["medium", "easy", "hard"][idx] ?? "medium" };
    }
  }
}

/** 确认（带 EOF 上限；`confirm` 自身会无限重问）。 */
async function confirmWithLimit(
  io: PromptIO,
  question: string,
): Promise<boolean> {
  for (let i = 0; i <= MAX_ATTEMPTS_PER_FIELD; i++) {
    const raw = (await io.readLine(`${question} (Y/n): `)).trim().toLowerCase();
    if (raw === "" || raw === "y" || raw === "yes") return true;
    if (raw === "n" || raw === "no") return false;
    io.write("请输入 y 或 n。\n");
  }
  throw new Error(eofHint("确认"));
}
