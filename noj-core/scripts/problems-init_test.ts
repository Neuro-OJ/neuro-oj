// 题目脚手架（`noj problems init`）单元测试。
//
// 重点验证「脚手架产物满足平台契约」，而不只是「文件被创建」：
// 生成的 manifest 能通过平台导入校验、模板不得分、evaluate 输出契约正确。

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import { join } from "node:path";
import {
  initProblem,
  InvalidSlugError,
  validateSlug,
} from "./problems-init.ts";

/** 建一个临时目录作为脚手架输出根。 */
async function makeTempRoot(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "noj-problems-init-" });
  return root;
}

Deno.test("validateSlug: 接受合法 slug", () => {
  for (const slug of ["a", "abc", "my-problem", "p1001", "a1-b2-c3"]) {
    validateSlug(slug);
  }
});

Deno.test("validateSlug: 拒绝非法 slug", () => {
  const bad = [
    "",
    "My-Problem", // 大写
    "my_problem", // 下划线
    "-leading",
    "trailing-",
    "double--dash",
    "has space",
    "has/slash",
    "../escape",
  ];
  for (const slug of bad) {
    let threw = false;
    try {
      validateSlug(slug);
    } catch (err) {
      threw = err instanceof InvalidSlugError;
    }
    assertEquals(threw, true, `slug 应被拒绝：${slug}`);
  }
});

Deno.test("initProblem: 生成全部必需文件", async () => {
  const root = await makeTempRoot();
  try {
    const result = await initProblem({ slug: "demo", title: "示例题", root });
    assertEquals(result.files, [
      "problem.json",
      "statement.md",
      "template.py",
      "evaluate.py",
      "visible.jsonl",
      "hidden.jsonl",
      "README.md",
    ]);

    for (const file of result.files) {
      const stat = await Deno.stat(join(result.dir, file));
      assertEquals(stat.isFile, true, `${file} 应存在且为文件`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: manifest 满足平台导入的硬性要求", async () => {
  const root = await makeTempRoot();
  try {
    const result = await initProblem({
      slug: "demo-manifest",
      title: "清单校验题",
      root,
    });
    const raw = await Deno.readTextFile(join(result.dir, "problem.json"));
    const manifest = JSON.parse(raw);

    // 平台导入会 400 拒绝的项：格式版本、必填、占位符
    assertEquals(manifest.format_version, 1);
    assertEquals(typeof manifest.title, "string");
    assertEquals(manifest.title.length > 0, true);
    assertEquals(manifest.type, "P");
    assertEquals(manifest.difficulty, "medium");
    // 编程题必须提供双容器 runtime_config
    assertEquals(typeof manifest.runtime_config, "object");
    assertEquals(
      manifest.runtime_config.evaluator.image,
      "noj-evaluator-python",
    );
    assertEquals(manifest.runtime_config.solution.image, "noj-solution-python");
    // 脚手架不得留下占位符（LLM 题才有 provider 占位，本骨架不含 llm 字段）
    assertEquals(raw.includes("REPLACE_WITH"), false, "不得含未替换占位符");
    assertEquals(manifest.llm, undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: template.py 保持未实现（质量规范：不得含可满分实现）", async () => {
  const root = await makeTempRoot();
  try {
    const result = await initProblem({ slug: "demo-template", root });
    const template = await Deno.readTextFile(join(result.dir, "template.py"));
    // 必须是「未实现」状态，防止空提交蒙分
    assertStringIncludes(template, "NotImplementedError");
    // 不得出现看起来像完整实现的返回
    assertEquals(
      /return\s+json\.dumps/.test(template),
      false,
      "模板不得包含可直接得分的实现",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: evaluate.py 输出契约正确（不输出顶层 status、含布尔 hidden）", async () => {
  const root = await makeTempRoot();
  try {
    const result = await initProblem({ slug: "demo-eval", root });
    const code = await Deno.readTextFile(join(result.dir, "evaluate.py"));

    // ---RESULT--- 标记 + score/details，且**不**输出顶层 status
    assertStringIncludes(code, "---RESULT---");
    assertStringIncludes(code, '"score"');
    assertStringIncludes(code, '"details"');
    assertEquals(
      /["']status["']\s*:/.test(
        code.replace(/"status": "Accepted" if passed else "WrongAnswer"/g, ""),
      ),
      false,
      "payload 不得含顶层 status",
    );

    // 隐藏/可见用例的裁剪：hidden 必须是布尔
    assertStringIncludes(code, '"hidden": hidden');
    // 仅可见用例附 input/expected/actual
    assertStringIncludes(code, "if not hidden:");
    // 运行期异常上抛（不吞异常）
    assertStringIncludes(code, "raise");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: 可见与隐藏用例均为合法 JSONL 且 id 不冲突", async () => {
  const root = await makeTempRoot();
  try {
    const result = await initProblem({ slug: "demo-data", root });
    const visible = (await Deno.readTextFile(join(result.dir, "visible.jsonl")))
      .trim().split("\n").map((l) => JSON.parse(l));
    const hidden = (await Deno.readTextFile(join(result.dir, "hidden.jsonl")))
      .trim().split("\n").map((l) => JSON.parse(l));

    assertEquals(visible.length > 0, true, "至少 1 条可见用例（题面示例）");
    assertEquals(hidden.length > 0, true, "至少 1 条隐藏用例");

    for (const row of [...visible, ...hidden]) {
      assertEquals(typeof row.id, "string");
      assertEquals(typeof row.input, "string");
      assertEquals("expected" in row, true);
    }

    const visibleIds = new Set(visible.map((r) => r.id));
    for (const row of hidden) {
      assertEquals(visibleIds.has(row.id), false, `id 冲突：${row.id}`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: statement.md 与 visible.jsonl 的示例一致", async () => {
  const root = await makeTempRoot();
  try {
    const result = await initProblem({ slug: "demo-stmt", root });
    const statement = await Deno.readTextFile(join(result.dir, "statement.md"));
    const firstVisible = JSON.parse(
      (await Deno.readTextFile(join(result.dir, "visible.jsonl"))).trim().split(
        "\n",
      )[0],
    );
    // 样例即测试：题面示例必须能在可见用例中找到（此处校验输入片段出现在题面）
    const input = JSON.parse(firstVisible.input);
    assertStringIncludes(statement, `"a": ${input.a}`);
    assertStringIncludes(statement, `"sum": ${firstVisible.expected.sum}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: 拒绝覆盖已存在的非空目录（保护出题人工作）", async () => {
  const root = await makeTempRoot();
  try {
    await initProblem({ slug: "existing", root });
    // 第二次生成到同一目录必须失败，而不是静默覆盖
    await assertRejects(
      () => initProblem({ slug: "existing", root }),
      Error,
      "已存在且非空",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: 拒绝非法 slug 与非法题型/难度", async () => {
  const root = await makeTempRoot();
  try {
    await assertRejects(
      () => initProblem({ slug: "Bad Slug", root }),
      InvalidSlugError,
    );
    await assertRejects(
      () => initProblem({ slug: "ok", type: "X" as unknown as "P", root }),
      Error,
      "题型非法",
    );
    await assertRejects(
      () =>
        initProblem({
          slug: "ok2",
          difficulty: "impossible" as unknown as "medium",
          root,
        }),
      Error,
      "难度非法",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: 自定义标题与难度被写入 manifest", async () => {
  const root = await makeTempRoot();
  try {
    const result = await initProblem({
      slug: "demo-custom",
      title: "自定义标题",
      difficulty: "easy",
      root,
    });
    const manifest = JSON.parse(
      await Deno.readTextFile(join(result.dir, "problem.json")),
    );
    assertEquals(manifest.title, "自定义标题");
    assertEquals(manifest.difficulty, "easy");

    // 标题也应出现在题面首行
    const statement = await Deno.readTextFile(join(result.dir, "statement.md"));
    assertStringIncludes(statement, "# 自定义标题");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
