/**
 * T22 测试：`problem init` 交互引导的 R6 验收。
 *
 * 全部注入 fake `PromptIO`（`tui/io.ts` 的抽象），**不读真实 stdin**。
 *
 * 本套测试的最高价值项是 **EOF 回归**：`guideProblemInit` 的 slug 校验循环此前在
 * `readLine` 返回空串时**永不退出**——用户按 Ctrl-D 会看到 "slug 非法" 被无限重复
 * （实测确认）。空串在"输入已结束（EOF）"与"用户直接回车"两种含义上不可区分，
 * 因此这里用**计数 fake 断言提问次数有上界**——那是"不挂死"的直接证据。
 *
 * R6 的三条验收对应：
 * 1. 引导覆盖四字段 + 校验 + **回退**（`planInitPrompts` + back 行为）；
 * 2. 非 TTY / `--no-interactive` 行为明确（缺参 → 用法错误 2）；
 * 3. 生成骨架后可通过 `problem lint`（端到端回归）。
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import type { PromptIO } from "../tui/io.ts";
import { makeTempDir } from "../testing/helpers.ts";
import { guideProblemInit, planInitPrompts } from "./tui.ts";
import { initProblemScaffold } from "./init.ts";
import { readBundleFiles } from "./command.ts";
import { lintBundle } from "./lint.ts";

/**
 * 脚本化的 fake IO。
 *
 * `answers` 按顺序消费；用尽后**恒返回 `""`**（模拟 EOF——这正是挂死用例需要的
 * 行为）。记录每次提问与写出的文案，供断言"问了几次"与"提示了什么"。
 */
function makeIO(answers: string[]): {
  io: PromptIO;
  asked: string[];
  written: string[];
} {
  const asked: string[] = [];
  const written: string[] = [];
  let i = 0;
  return {
    asked,
    written,
    io: {
      write(text) {
        written.push(text);
      },
      readLine(prompt) {
        asked.push(prompt);
        const value = i < answers.length ? answers[i]! : "";
        i++;
        return Promise.resolve(value);
      },
      readSecret(prompt) {
        asked.push(prompt);
        const value = i < answers.length ? answers[i]! : "";
        i++;
        return Promise.resolve(value);
      },
    },
  };
}

// ---------------- planInitPrompts：已给旗标的字段不再提问 ----------------

Deno.test("T22 planInitPrompts：全部已给 → 一个都不问", () => {
  assertEquals(
    planInitPrompts({
      slug: "a-plus-b",
      title: "A+B",
      type: "P",
      difficulty: "medium",
    }),
    { askSlug: false, askTitle: false, askType: false, askDifficulty: false },
  );
});

Deno.test("T22 planInitPrompts：部分已给 → 只问缺的（逐字段）", () => {
  assertEquals(planInitPrompts({ slug: "a-plus-b" }), {
    askSlug: false,
    askTitle: true,
    askType: true,
    askDifficulty: true,
  });
  assertEquals(planInitPrompts({ type: "U", difficulty: "hard" }), {
    askSlug: true,
    askTitle: true,
    askType: false,
    askDifficulty: false,
  });
  // 空串视为"未给"（与 command.ts 传 undefined/有值 的语义一致）
  assertEquals(planInitPrompts({ slug: "" }).askSlug, true);
});

// ---------------- 覆盖与默认值 ----------------

Deno.test("T22 引导：四个字段都问到，且返回值正确", async () => {
  const { io, asked } = makeIO([
    "a-plus-b", // slug
    "A+B 求和", // title
    "1", // type: P
    "1", // difficulty: medium
    "y", // 确认
  ]);
  const answers = await guideProblemInit(io, {});
  assertEquals(answers.slug, "a-plus-b");
  assertEquals(answers.title, "A+B 求和");
  assertEquals(answers.type, "P");
  assertEquals(answers.difficulty, "medium");
  // 四个字段各问一次 + 一次确认
  assertEquals(asked.length, 5);
});

Deno.test("T22 引导：已给旗标的字段不再提问", async () => {
  const { io, asked } = makeIO([
    "只看难度", // title（标题回车默认取 slug）
    "3", // difficulty: hard
    "y",
  ]);
  const answers = await guideProblemInit(io, { slug: "only-diff", type: "P" });
  assertEquals(answers.slug, "only-diff");
  assertEquals(answers.type, "P");
  assertEquals(answers.difficulty, "hard");
  // slug 与 type 未提问 → 总提问数 = title + difficulty + 确认
  assertEquals(asked.length, 3);
  assert(
    !asked.some((p) => p.includes("题目 slug")),
    "已给 slug 就不该再问 slug",
  );
});

Deno.test("T22 引导：标题回车接受 slug 作为默认值", async () => {
  const { io } = makeIO([
    "my-problem", // slug
    "", // title 回车 → 默认 slug
    "", // type 回车 → 第 1 项 P
    "", // difficulty 回车 → 第 1 项 medium
    "", // 确认回车 → 默认 Y
  ]);
  const answers = await guideProblemInit(io, {});
  assertEquals(answers.title, "my-problem");
  assertEquals(answers.type, "P");
  assertEquals(answers.difficulty, "medium");
});

Deno.test("T22 引导：type 选第 2 项 → U；difficulty 选第 3 项 → hard", async () => {
  const { io } = makeIO(["slug-x-1", "t", "2", "3", "y"]);
  const answers = await guideProblemInit(io, {});
  assertEquals(answers.type, "U");
  assertEquals(answers.difficulty, "hard");
});

// ---------------- 校验：非法输入重新提问 ----------------

Deno.test("T22 校验：非法 slug 重新提问，合法后继续", async () => {
  const { io, asked, written } = makeIO([
    "BAD_UPPER", // 大写 → 拒绝
    "ab", // 过短 → 拒绝
    "-lead", // 首字符连字符 → 拒绝
    "trail-", // 尾字符连字符 → 拒绝
    "under_score", // 下划线 → 拒绝
    "good-slug", // 合法
    "", // title
    "", // type
    "", // difficulty
    "y",
  ]);
  const answers = await guideProblemInit(io, {});
  assertEquals(answers.slug, "good-slug");
  // slug 被问了 6 次（5 次非法 + 1 次合法）。只数**提问**（带进度前缀），
  // 否则会把提示行也算进去。
  assertEquals(asked.filter((p) => p.includes("题目 slug")).length, 6);
  // 每次拒绝都有可读提示（5 次非法 → 恰好 5 条）
  assertEquals(
    written.filter((w) => w.includes("slug 非法")).length,
    5,
    "每次非法输入都应给出提示",
  );
});

Deno.test("T22 校验：select 非法编号重新提问（由 widgets 保证）", async () => {
  const { io, written } = makeIO([
    "ok-slug",
    "t",
    "9", // type 非法编号
    "abc", // type 非法编号
    "1", // 合法
    "1",
    "y",
  ]);
  const answers = await guideProblemInit(io, {});
  assertEquals(answers.type, "P");
  assertStringIncludes(written.join(""), "输入无效");
});

// ---------------- EOF / 连续空输入：必须有限次后报错（回归） ----------------

Deno.test("T22 EOF 回归：readLine 恒返回空串时**有限次**后报错（不挂死）", async () => {
  // 关键：answers 用尽后 fake 恒返回 ""（模拟 Ctrl-D / EOF）。
  // 若不设上限，slug 的校验循环会永远转下去——本用例就会超时。
  const { io, asked } = makeIO([]);
  let error: Error | null = null;
  try {
    await guideProblemInit(io, {});
  } catch (err) {
    error = err as Error;
  }
  assert(error !== null, "EOF 必须抛错，而不是无限循环");
  // 提问次数有上界（直接证据）
  assert(
    asked.length <= 10,
    `EOF 下提问次数必须有上界，实得 ${asked.length}`,
  );
  // 报错必须可操作：说明输入结束，并给出自动化路径
  assertStringIncludes(error!.message, "输入已结束");
  assertStringIncludes(error!.message, "--no-interactive");
  assertStringIncludes(error!.message, "--slug");
});

Deno.test("T22 EOF：slug 无默认值，EOF 下有界报错（唯一会挂死的字段）", async () => {
  // 说明：title 走 `input(def)`、type/difficulty 走 `select(defaultIndex)`——
  // 它们的空输入会**取默认值**（既有 UX），因此在 EOF 下不会挂死。
  // 真正会挂死的是 **slug**（空串非法且无默认）与**确认环节**（非法词重问）。
  const { io, asked } = makeIO([]);
  let error: Error | null = null;
  try {
    await guideProblemInit(io, { title: "T", type: "P", difficulty: "easy" });
  } catch (err) {
    error = err as Error;
  }
  assert(error !== null, "slug 处 EOF 必须抛错");
  assert(asked.length <= 20, `提问次数有上界，实得 ${asked.length}`);
});

Deno.test("T22 EOF：确认环节的无限非法输入有界报错（confirm 会重问）", async () => {
  const { io, asked } = makeIO([
    "ok-slug",
    "T",
    "1",
    "1",
    ...Array.from({ length: 40 }, () => "maybe"), // 确认处反复给非法词
  ]);
  let error: Error | null = null;
  try {
    await guideProblemInit(io, {});
  } catch (err) {
    error = err as Error;
  }
  assert(error !== null, "确认环节的无限非法输入必须有界报错");
  assert(asked.length <= 30, `提问次数有上界，实得 ${asked.length}`);
  assertStringIncludes(error!.message, "确认");
});

Deno.test("T22 EOF：恰好问到上限前给出合法值仍可成功（上限不误伤）", async () => {
  // 前 2 次非法、第 3 次合法 → 必须成功（上限只挡无限空输入）
  const { io } = makeIO([
    "BAD",
    "also bad",
    "fine-slug",
    "",
    "",
    "",
    "y",
  ]);
  const answers = await guideProblemInit(io, {});
  assertEquals(answers.slug, "fine-slug");
});

// ---------------- 回退（back） ----------------

Deno.test("T22 回退：在后续字段输入 back 会回到上一个字段重新提问", async () => {
  const { io, asked } = makeIO([
    "first-slug", // slug
    "First Title", // title
    "back", // type 处回退 → 回到 title
    "Second Title", // 重新问 title
    "1", // type
    "1", // difficulty
    "y",
  ]);
  const answers = await guideProblemInit(io, {});
  assertEquals(answers.slug, "first-slug");
  assertEquals(answers.title, "Second Title", "回退后应能改掉 title");
  assertEquals(answers.type, "P");
  // title 被问了两次（回退前后各一次）
  assertEquals(asked.filter((p) => p.includes("题目标题")).length, 2);
});

Deno.test("T22 回退：第一个字段（slug）用 :b 回退 → 无处可退，给提示后重问", async () => {
  // 注意：slug 字段**只认 `:b`**（不认 `back`），因为 `back` 本身是合法 slug
  // ——把它当回退会夺走一个合法的题目名。歧义时优先"输入即数据"。
  const { io, written, asked } = makeIO([
    ":b", // slug 处回退 → 无处可退
    "real-slug", // 重问
    "",
    "",
    "",
    "y",
  ]);
  const answers = await guideProblemInit(io, {});
  assertEquals(answers.slug, "real-slug");
  assertStringIncludes(written.join(""), "已经是第一步");
  assertEquals(asked.filter((p) => p.includes("题目 slug")).length, 2);
});

Deno.test("T22 回退：slug 处输入 back 被当作**合法题目名**（不夺走合法数据）", async () => {
  const { io } = makeIO([
    "back", // 合法 slug（4 个小写字母）→ 必须被接受
    "", // title 回车 → 默认取 slug
    "", // type 回车 → 默认 P
    "", // difficulty 回车 → 默认 medium
    "y", // 确认
  ]);
  const answers = await guideProblemInit(io, {});
  assertEquals(answers.slug, "back", "back 是合法 slug，不得被误当回退");
});

Deno.test("T22 回退：`:b` 别名同样生效", async () => {
  const { io } = makeIO([
    "s-1",
    "T1",
    ":b", // type 处回退
    "T2",
    "1",
    "1",
    "y",
  ]);
  const answers = await guideProblemInit(io, {});
  assertEquals(answers.title, "T2");
});

Deno.test("T22 回退：回退次数也受上限约束（不挂死）", async () => {
  const { io, asked } = makeIO([
    "s",
    "T",
    "back",
    "back",
    "back",
    "back",
    "back",
    "back",
    "back",
    "back",
    "back",
    "back",
  ]);
  let error: Error | null = null;
  try {
    await guideProblemInit(io, {});
  } catch (err) {
    error = err as Error;
  }
  assert(error !== null, "无限回退必须有上界");
  assert(asked.length <= 40, `提问次数有上界，实得 ${asked.length}`);
});

// ---------------- 进度提示 ----------------

Deno.test("T22 进度：提示里带 [当前/总数]，且总数随已给旗标变化", async () => {
  // 全部都要问 → 总数 4
  const all = makeIO(["s-1", "T", "1", "1", "y"]);
  await guideProblemInit(all.io, {});
  const allText = all.asked.join("\n") + all.written.join("\n");
  assertStringIncludes(allText, "[1/4]");

  // 已给 slug+type → 总数 2
  const partial = makeIO(["T", "1", "y"]);
  await guideProblemInit(partial.io, { slug: "s-2", type: "P" });
  const partialText = partial.asked.join("\n") + partial.written.join("\n");
  assertStringIncludes(partialText, "[1/2]");
});

// ---------------- 确认与取消 ----------------

Deno.test("T22 确认：拒绝确认 → 抛『已取消』", async () => {
  const { io } = makeIO(["s-1", "T", "1", "1", "n"]);
  await assertRejects(() => guideProblemInit(io, {}), Error, "已取消");
});

// ---------------- 端到端：生成的骨架通过 problem lint（R6 第三条） ----------------

Deno.test("T22 端到端：引导答案 → 生成骨架 → 通过 problem lint", async () => {
  const root = await makeTempDir();
  try {
    // 用引导收集答案（注入 fake IO），再交给真实的 initProblemScaffold
    const { io } = makeIO([
      "guided-problem",
      "引导生成的题目",
      "1", // P
      "1", // medium
      "y",
    ]);
    const answers = await guideProblemInit(io, {});
    const result = await initProblemScaffold({
      root,
      slug: answers.slug,
      title: answers.title,
      type: answers.type,
      difficulty: answers.difficulty,
    });
    assert(result.dir.length > 0);

    // 生成的骨架必须能通过 lint（R6 第三条验收）
    const lint = lintBundle(await readBundleFiles(join(root, answers.slug)));
    const errors = lint.findings.filter((f) => f.level === "error");
    assertEquals(
      errors,
      [],
      `生成的骨架不得有 lint error：${JSON.stringify(errors)}`,
    );
    // 且 manifest 反映了引导答案
    const manifest = JSON.parse(
      await Deno.readTextFile(join(root, answers.slug, "problem.json")),
    );
    assertEquals(manifest.title, "引导生成的题目");
    assertEquals(manifest.difficulty, "medium");
    assertEquals(manifest.type, "P");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
