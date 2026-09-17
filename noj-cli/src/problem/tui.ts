/**
 * `problem init` 的 TUI 引导（#514 P6）。
 *
 * 复用既有 TUI 基座（`tui/io.ts` 的 PromptIO + `tui/widgets.ts` 的
 * input/select/confirm），不引入新依赖——这正是 issue 所指
 * 「TUI 能力闲置」的正解：能力早已具备，只是没接到题目包流程。
 *
 * 与非交互模式的分工：
 * - 交互模式（默认，且 stdin 是 TTY）：缺什么问什么，带默认值；
 * - `--no-interactive` 或非 TTY：不提问，直接要求显式参数（避免 #517 修过的空转）。
 */
import type { PromptIO } from "../tui/io.ts";
import { confirm, input, select } from "../tui/widgets.ts";

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

/** slug 合法性（与 init.ts 的 SLUG_PATTERN 保持一致）。 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/**
 * 运行交互式引导。
 *
 * 只在 TTY 下调用；非 TTY 由调用方直接报错（见 command.ts）。
 * 所有问题都带默认值，回车即可接受，降低出题人的输入负担。
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

  let slug = partial.slug ?? "";
  if (plan.askSlug) {
    // slug 是目录名，必须有值且合法：循环直到通过
    for (;;) {
      const raw = await input(
        io,
        "题目 slug（小写字母/数字/连字符，如 a-plus-b）",
      );
      if (SLUG_RE.test(raw)) {
        slug = raw;
        break;
      }
      io.write("slug 非法：要求 3-64 位小写字母/数字/连字符，首尾非连字符。\n");
    }
  }

  const title = plan.askTitle
    ? await input(io, "题目标题", slug)
    : partial.title;

  let type = partial.type ?? "";
  if (plan.askType) {
    const idx = await select(io, "题目归属", [
      "P（主题库，默认）",
      "U（用户题库，visibility=private）",
    ]);
    type = idx === 0 ? "P" : "U";
  }

  let difficulty = partial.difficulty ?? "";
  if (plan.askDifficulty) {
    const idx = await select(io, "难度", [
      "medium（中等，默认）",
      "easy（简单）",
      "hard（困难）",
    ]);
    difficulty = ["medium", "easy", "hard"][idx] ?? "medium";
  }

  const ok = await confirm(
    io,
    `确认生成：${slug}（${type} / ${difficulty}）`,
    true,
  );
  if (!ok) {
    throw new Error("已取消");
  }

  return { slug, title, type, difficulty };
}
