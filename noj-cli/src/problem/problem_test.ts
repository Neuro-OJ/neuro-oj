import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { lintBundle, runQualityRules } from "./lint.ts";
import { packBundle, shouldExclude } from "./pack.ts";
import { initProblemScaffold, validateSlug } from "./init.ts";
import { parseProblemArgs } from "./command.ts";

Deno.test("parseProblemArgs: init 选项与位置参数", () => {
  const a = parseProblemArgs([
    "init",
    "my-problem",
    "--type",
    "P",
    "--difficulty",
    "hard",
    "--title",
    "标题",
    "--no-interactive",
  ]);
  assertEquals(a.sub, "init");
  assertEquals(a.slug, "my-problem");
  assertEquals(a.type, "P");
  assertEquals(a.difficulty, "hard");
  assertEquals(a.title, "标题");
  assertEquals(a.noInteractive, true);
});

Deno.test("parseProblemArgs: lint 位置参数是 dir 而非 slug", () => {
  const a = parseProblemArgs(["lint", "./some-dir", "--strict", "--json"]);
  assertEquals(a.sub, "lint");
  assertEquals(a.dir, "./some-dir");
  assertEquals(a.slug, undefined);
  assertEquals(a.strict, true);
  assertEquals(a.json, true);
});

Deno.test("parseProblemArgs: 支持 --dir 与 --out", () => {
  assertEquals(parseProblemArgs(["init", "x", "--dir", "/root"]).dir, "/root");
  assertEquals(parseProblemArgs(["pack", "--out", "/o"]).out, "/o");
});

Deno.test("parseProblemArgs: 选项缺值报用法错误", () => {
  let threw = false;
  try {
    parseProblemArgs(["init", "x", "--title"]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("parseProblemArgs: 未知选项报错（不静默忽略）", () => {
  let threw = false;
  try {
    parseProblemArgs(["lint", "--bogus"]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("validateSlug: 合法与非法", () => {
  validateSlug("a-plus-b");
  validateSlug("abc");
  for (const bad of ["A-B", "-abc", "abc-", "ab", "a b", "a_b"]) {
    let threw = false;
    try {
      validateSlug(bad);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `slug「${bad}」应被拒绝`);
  }
});

Deno.test("shouldExclude: 对齐 noj.ts 的排除规则", () => {
  // 参考实现
  assertEquals(shouldExclude("submission.py"), true);
  assertEquals(shouldExclude("submission_secret.py"), true);
  assertEquals(shouldExclude("sub/submission.py"), true);
  // 字节码
  assertEquals(shouldExclude("__pycache__/a.pyc"), true);
  // git
  assertEquals(shouldExclude(".git/config"), true);
  // 打包脚本
  assertEquals(shouldExclude("build_bundle.sh"), true);
  // 模板文件必须**排除**（规范 problem-bundle.md:26 + 旧 noj.ts 行为；
  // 编辑器模板从 data/problems-src 读取，不从包里读）
  assertEquals(shouldExclude("template.py", "template.py"), true);
  assertEquals(shouldExclude("my-template.py", "my-template.py"), true);
  // 正常文件保留
  assertEquals(shouldExclude("evaluate.py"), false);
  assertEquals(shouldExclude("problem.json"), false);
});

Deno.test("packBundle: 排除项不出现在产物中，且可被解压回来", () => {
  const enc = new TextEncoder();
  const result = packBundle({
    entries: {
      "problem.json": enc.encode('{"format_version":1,"title":"t"}'),
      "evaluate.py": enc.encode("print(1)"),
      "submission.py": enc.encode("SECRET"),
      "__pycache__/x.pyc": enc.encode("junk"),
    },
  });
  assertEquals(result.excluded.sort(), ["__pycache__/x.pyc", "submission.py"]);
  assertEquals(result.included.sort(), ["evaluate.py", "problem.json"]);
});

Deno.test("lintBundle: 合法包无 error", () => {
  const report = lintBundle({
    texts: {
      "problem.json": JSON.stringify({
        format_version: 1,
        title: "t",
        runtime_config: {
          evaluator: {
            image: "i:1",
            command: "c",
            time_limit_ms: 1,
            memory_limit_mb: 1,
          },
          solution: { image: "i:1", call_timeout_ms: 1, memory_limit_mb: 1 },
        },
      }),
      "evaluate.py": "print(1)",
    },
    names: ["problem.json", "evaluate.py"],
  });
  assertEquals(report.hasError, false);
});

Deno.test("lintBundle: 缺 manifest / 缺 evaluator / JSON 非法均为 error", () => {
  const missingManifest = lintBundle({ texts: {}, names: [] });
  assertEquals(missingManifest.hasError, true);
  assertEquals(
    missingManifest.findings.some((f) => f.rule === "must/missing-manifest"),
    true,
  );

  const badJson = lintBundle({
    texts: { "problem.json": "{not json" },
    names: ["problem.json"],
  });
  assertEquals(badJson.hasError, true);

  const noEvaluator = lintBundle({
    texts: {
      "problem.json": JSON.stringify({
        format_version: 1,
        title: "t",
        runtime_config: {
          evaluator: {
            image: "i",
            command: "c",
            time_limit_ms: 1,
            memory_limit_mb: 1,
          },
          solution: { image: "i", call_timeout_ms: 1, memory_limit_mb: 1 },
        },
      }),
    },
    names: ["problem.json"],
  });
  assertEquals(noEvaluator.hasError, true);
  assertEquals(
    noEvaluator.findings.some((f) => f.rule === "must/missing-evaluator"),
    true,
  );
});

Deno.test("runQualityRules: 模板疑似完整实现 → 警告", () => {
  const findings = runQualityRules({
    files: {
      texts: {
        "template.py": "def solve\n    return 42\n",
        "hidden.jsonl": "",
      },
      names: ["template.py", "hidden.jsonl"],
    },
    manifest: {},
  });
  assertEquals(
    findings.some((f) => f.rule === "quality/template-may-be-complete"),
    true,
  );
});

Deno.test("runQualityRules: 模板含占位 → 不告警", () => {
  const findings = runQualityRules({
    files: {
      texts: {
        "template.py": "def solve(a, b):\n    raise NotImplementedError\n",
        "hidden.jsonl": "",
      },
      names: ["template.py", "hidden.jsonl"],
    },
    manifest: {},
  });
  assertEquals(
    findings.some((f) => f.rule === "quality/template-may-be-complete"),
    false,
  );
});

Deno.test("runQualityRules: 隐藏用例泄露到可见文件 → 警告", () => {
  const secret = JSON.stringify({
    input: "SECRET-INPUT-1234567890",
    output: "42",
  });
  const findings = runQualityRules({
    files: {
      texts: {
        "hidden.jsonl": secret,
        "statement.md": `样例：${secret}`,
      },
      names: ["hidden.jsonl", "statement.md"],
    },
    manifest: {},
  });
  assertEquals(
    findings.some((f) => f.rule === "quality/hidden-case-leak"),
    true,
  );
});

Deno.test("initProblemScaffold: 生成骨架且拒绝非空目录", async () => {
  const root = await Deno.makeTempDir();
  try {
    const r = await initProblemScaffold({
      slug: "my-problem",
      root,
      type: "P",
      difficulty: "easy",
      title: "标题",
    });
    assertEquals(r.files.length, 7);
    const manifest = JSON.parse(
      await Deno.readTextFile(join(r.dir, "problem.json")),
    );
    assertEquals(manifest.title, "标题");
    assertEquals(manifest.type, "P");

    // 二次调用：目录非空 → 拒绝
    await assertRejects(() =>
      initProblemScaffold({ slug: "my-problem", root })
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblemScaffold: 拒绝符号链接目标", async () => {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  try {
    await Deno.symlink(outside, join(root, "linked"), { type: "dir" });
    await assertRejects(() => initProblemScaffold({ slug: "linked", root }));
    // 确认没有写到链接目标之外
    const entries = [...Deno.readDirSync(outside)];
    assertEquals(entries.length, 0, "不得写入符号链接目标");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("initProblemScaffold: 非法 type/difficulty 拒绝", async () => {
  const root = await Deno.makeTempDir();
  try {
    await assertRejects(() =>
      initProblemScaffold({ slug: "x-y-z", root, type: "Z" })
    );
    await assertRejects(() =>
      initProblemScaffold({ slug: "x-y-z", root, difficulty: "insane" })
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ── 评审修正：vendored 副本的同步警示必须存在（issue #514 硬要求）──────

Deno.test("vendored 副本：每个文件都必须有同步警示与原始路径", async () => {
  const dir = new URL("./vendor/", import.meta.url);
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.endsWith(".ts")) files.push(e.name);
  }
  assertEquals(files.length > 0, true, "vendor 目录不应为空");
  for (const name of files) {
    const text = await Deno.readTextFile(new URL(name, dir));
    assertEquals(
      text.includes("本文件是 noj-core 的刻意副本"),
      true,
      `${name} 缺少「刻意副本」警示`,
    );
    // 必须写明原始路径，否则无法同步
    assertEquals(
      /原始路径：noj-core\//.test(text),
      true,
      `${name} 缺少原始路径`,
    );
  }
});

Deno.test("pack: 模板文件必须被排除（规范 problem-bundle.md:26）", () => {
  // 评审修正：早先把 template.py 打进包，违背规范与旧 noj.ts 行为
  assertEquals(shouldExclude("template.py", "template.py"), true);
  assertEquals(shouldExclude("template.py"), true);
  assertEquals(shouldExclude("custom-tpl.py", "custom-tpl.py"), true);
});
