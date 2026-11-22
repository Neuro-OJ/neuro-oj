/**
 * `problem init --template`（P0-2 B）单元测试。
 *
 * 每个模板生成后都必须：lint 零发现（含 SHOULD 层）、manifest 通过 core 校验、
 * 自带参考解答与断言、打包时 submissions/ 不进包。真实 Docker 验题由 CI 的
 * problem-local-test 作业对五个模板逐一执行 `problem test`。
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { validateBundleManifest } from "../../../noj-core/src/modules/problems/types/problem-bundle.ts";
import { renderProblemTemplate } from "../../../noj-core/scripts/problem-templates.ts";
import { UsageError } from "../util/args.ts";
import { lintBundle } from "./lint.ts";
import { buildSupportPackage } from "./judge-local.ts";
import { unzipSync } from "fflate";
import { initProblemScaffold, PROBLEM_TEMPLATE_NAMES } from "./init.ts";
import {
  parseProblemArgs,
  readBundleFiles,
  runProblemInit,
} from "./command.ts";

for (const name of PROBLEM_TEMPLATE_NAMES) {
  Deno.test(`init --template ${name}：lint 零发现且自带参考解答`, async () => {
    const root = await Deno.makeTempDir();
    try {
      const result = await initProblemScaffold({
        slug: `tpl-${name}`,
        title: `我的${name}题`,
        difficulty: "hard",
        template: name,
        root,
      });
      assertEquals(
        result.files,
        renderProblemTemplate(name, {
          title: `我的${name}题`,
          difficulty: "hard",
        }).map(([path]) => path),
      );

      const report = lintBundle(await readBundleFiles(result.dir));
      assertEquals(report.findings, []);

      const manifest = JSON.parse(
        await Deno.readTextFile(join(result.dir, "problem.json")),
      );
      assertEquals(manifest.title, `我的${name}题`);
      assertEquals(manifest.difficulty, "hard");
      validateBundleManifest(manifest);

      const readme = await Deno.readTextFile(join(result.dir, "README.md"));
      assert(readme.startsWith(`# 我的${name}题\n`));

      const expect = JSON.parse(
        await Deno.readTextFile(join(result.dir, "submissions/expect.json")),
      ) as Record<string, string>;
      assertEquals(Object.keys(expect).sort(), ["empty", "good", "wrong"]);
      assertEquals(expect.good, "=100");

      if (name !== "objective") {
        const support = unzipSync(await buildSupportPackage(result.dir));
        assert(
          Object.keys(support).every((p) => !p.startsWith("submissions")),
          "参考解答不得进入支持包",
        );
        assert("evaluate.py" in support);
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

Deno.test("init --template：未给标题时用 slug，难度缺省 medium", async () => {
  const root = await Deno.makeTempDir();
  try {
    const result = await initProblemScaffold({
      slug: "plain-code",
      template: "code",
      root,
    });
    const manifest = JSON.parse(
      await Deno.readTextFile(join(result.dir, "problem.json")),
    );
    assertEquals(manifest.title, "plain-code");
    assertEquals(manifest.difficulty, "medium");
    const statement = await Deno.readTextFile(
      join(result.dir, "statement.md"),
    );
    assert(statement.startsWith("# plain-code\n"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("init --template：与 --judge-type oi 互斥、未知模板拒绝", async () => {
  const root = await Deno.makeTempDir();
  try {
    await assertRejects(
      () =>
        initProblemScaffold({
          slug: "conflict",
          template: "code",
          judgeType: "oi",
          root,
        }),
      Error,
      "不能同时使用",
    );
    await assertRejects(
      () =>
        initProblemScaffold({
          slug: "unknown",
          // deno-lint-ignore no-explicit-any
          template: "kaggle" as any,
          root,
        }),
      Error,
      "未知模板",
    );
    // 拒绝发生在写入之前：不留下目录
    for await (const _ of Deno.readDir(root)) {
      throw new Error("参数非法时不应创建任何目录");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("parseProblemArgs / runProblemInit：--template 解析与用法错误", async () => {
  const a = parseProblemArgs(["init", "x-y", "--template", "llm"]);
  assertEquals(a.template, "llm");

  const root = await Deno.makeTempDir();
  try {
    const bad = parseProblemArgs([
      "init",
      "bad-template",
      "--template",
      "kaggle",
      "--no-interactive",
      "--dir",
      root,
    ]);
    const err = await assertRejects(() => runProblemInit(bad), UsageError);
    assertStringIncludes(err.message, "code/prediction/llm/objective/ui");

    const oi = parseProblemArgs([
      "init",
      "oi-template",
      "--template",
      "code",
      "--judge-type",
      "oi",
      "--no-interactive",
      "--dir",
      root,
    ]);
    await assertRejects(() => runProblemInit(oi), UsageError);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("lintBundle：questions.json 按导入规则校验", () => {
  const report = lintBundle({
    names: ["problem.json", "questions.json"],
    texts: {
      "problem.json": JSON.stringify({
        format_version: 3,
        kind: "objective",
        title: "t",
      }),
      // 常见错误：题干写成 title、选项写成对象、答案不是数组
      "questions.json": JSON.stringify([{
        key: "q1",
        type: "single",
        title: "题干",
        options: { A: "a", B: "b" },
        answer: "A",
      }]),
    },
  });
  assertEquals(report.hasError, true);
  assertEquals(
    report.findings.map((f) => f.rule),
    ["must/questions-invalid"],
  );
});
