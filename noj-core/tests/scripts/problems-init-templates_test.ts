// `noj problems init --template`（P0-2 B）单元测试。
//
// 位置说明同 problems-init_test.ts：放在 tests/scripts/ 才会被 CI 的
// core-shared 作业（scripts/test-shared.sh）收集。
//
// 真实 Docker 验题（满分解 100、错解低分、空解 0）由 CI 的 problem-local-test
// 作业对五个模板逐一执行 `noj-cli problem test`；这里锁定契约：
//   1. 嵌入模块与模板目录一致（生成器 --check 同款判定）；
//   2. 每个模板的 manifest 过平台校验，且自带三类参考解答与断言；
//   3. initProblem 按模板写出完整目录（含子目录）、改写标题与难度。

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { join } from "node:path";
import { validateBundleManifest } from "../../src/modules/problems/types/problem-bundle.ts";
import { initProblem } from "../../scripts/problems-init.ts";
import {
  PROBLEM_TEMPLATE_NAMES,
  renderProblemTemplate,
} from "../../scripts/problem-templates.ts";
import { PROBLEM_TEMPLATE_FILES } from "../../scripts/problem-templates.generated.ts";
import {
  collectTemplates,
  generate,
} from "../../scripts/gen-problem-templates.ts";

Deno.test("problem-templates：嵌入模块与模板目录一致", async () => {
  assertEquals(
    await generate(true),
    true,
    "请运行 deno run -A noj-core/scripts/gen-problem-templates.ts",
  );
  const onDisk = await collectTemplates();
  assertEquals(
    Object.keys(onDisk).sort(),
    [...PROBLEM_TEMPLATE_NAMES].sort(),
    "模板目录与 PROBLEM_TEMPLATE_NAMES 必须一一对应",
  );
  assertEquals(
    Object.keys(PROBLEM_TEMPLATE_FILES).sort(),
    Object.keys(onDisk).sort(),
  );
});

for (const name of PROBLEM_TEMPLATE_NAMES) {
  Deno.test(`problem-templates/${name}：manifest 合法且自带三类参考解答`, () => {
    const files = Object.fromEntries(renderProblemTemplate(name));
    const manifest = validateBundleManifest(JSON.parse(files["problem.json"]));
    assertEquals(manifest.kind, name === "objective" ? "objective" : "ai");

    const expect = JSON.parse(files["submissions/expect.json"]) as Record<
      string,
      string
    >;
    assertEquals(Object.keys(expect).sort(), ["empty", "good", "wrong"]);
    for (const solution of Object.keys(expect)) {
      assert(
        Object.keys(files).some((p) =>
          p.startsWith(`submissions/${solution}.`)
        ),
        `缺少参考解答 submissions/${solution}.*`,
      );
    }
    assert(files["README.md"], "模板必须带 README.md");
    // README 不用待办复选框：生成后的题目应能通过 lint --strict。
    assert(!files["README.md"].includes("- [ ]"));
  });
}

Deno.test("initProblem --template：写出完整目录并改写标题与难度", async () => {
  const root = await Deno.makeTempDir({ prefix: "noj-problems-tpl-" });
  try {
    const result = await initProblem({
      slug: "tpl-llm",
      title: "订单号提取",
      difficulty: "hard",
      template: "llm",
      root,
    });
    const expected = renderProblemTemplate("llm", {
      title: "订单号提取",
      difficulty: "hard",
    });
    assertEquals(result.files, expected.map(([path]) => path));
    for (const [path, content] of expected) {
      assertEquals(await Deno.readTextFile(join(result.dir, path)), content);
    }
    const manifest = JSON.parse(
      await Deno.readTextFile(join(result.dir, "problem.json")),
    );
    assertEquals(manifest.title, "订单号提取");
    assertEquals(manifest.difficulty, "hard");
    assertEquals(manifest.llm.max_calls, 12);
    const statement = await Deno.readTextFile(
      join(result.dir, "statement.md"),
    );
    assert(statement.startsWith("# 订单号提取\n"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem --template：未知模板在写入前拒绝", async () => {
  const root = await Deno.makeTempDir({ prefix: "noj-problems-tpl-" });
  try {
    await assertRejects(
      () =>
        initProblem({
          slug: "bad-template",
          // deno-lint-ignore no-explicit-any
          template: "kaggle" as any,
          root,
        }),
      Error,
      "未知模板",
    );
    for await (const _ of Deno.readDir(root)) {
      throw new Error("参数非法时不应创建任何目录");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
