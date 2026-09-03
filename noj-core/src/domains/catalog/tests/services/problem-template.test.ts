/**
 * getProblemTemplate 单元测试（纯文件系统，无 DB 依赖）。
 *
 * 覆盖：manifest.template 缺省默认 template.py、自定义文件名、
 * manifest 损坏回退、非法值回退、模板文件缺失返回 null。
 * 通过注入 srcRoot 指向临时目录，不触碰真实 data/problems-src。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { getProblemTemplate } from "../../index.ts";

/**
 * 在临时目录中构造 problems-src 结构并执行断言，结束后清理。
 *
 * @param files 相对 srcRoot 的文件路径 → 内容（如 `source-a/problem.json`）
 */
async function withTmpSrcRoot(
  files: Record<string, string>,
  fn: (srcRoot: string) => Promise<void>,
): Promise<void> {
  const srcRoot = await Deno.makeTempDir({ prefix: "noj-template-test-" });
  try {
    for (const [rel, content] of Object.entries(files)) {
      const p = `${srcRoot}/${rel}`;
      const dir = p.slice(0, p.lastIndexOf("/"));
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(p, content);
    }
    await fn(srcRoot);
  } finally {
    await Deno.remove(srcRoot, { recursive: true });
  }
}

Deno.test("getProblemTemplate: 无 template 字段时按默认 template.py 读取", async () => {
  await withTmpSrcRoot(
    {
      "source-a/problem.json": JSON.stringify({ number: 1001, title: "t" }),
      "source-a/template.py": "print('hello')",
    },
    async (srcRoot) => {
      const tpl = await getProblemTemplate(
        { number: 1001, title: "t" },
        srcRoot,
      );
      assertEquals(tpl, { content: "print('hello')", language: "python3" });
    },
  );
});

Deno.test("getProblemTemplate: 显式 template 字段按自定义文件名读取", async () => {
  await withTmpSrcRoot(
    {
      "source-a/problem.json": JSON.stringify({
        number: 1001,
        title: "t",
        template: "starter.py",
      }),
      "source-a/starter.py": "print('starter')",
    },
    async (srcRoot) => {
      const tpl = await getProblemTemplate(
        { number: 1001, title: "t" },
        srcRoot,
      );
      assertEquals(tpl?.content, "print('starter')");
    },
  );
});

Deno.test("getProblemTemplate: manifest 损坏时不返回无法确认归属的模板", async () => {
  await withTmpSrcRoot(
    {
      "source-a/problem.json": "{broken json",
      "source-a/template.py": "print('default')",
    },
    async (srcRoot) => {
      const tpl = await getProblemTemplate(
        { number: 1001, title: "t" },
        srcRoot,
      );
      assertEquals(tpl, null);
    },
  );
});

Deno.test("getProblemTemplate: 非法 template 值（路径穿越）回退默认名", async () => {
  await withTmpSrcRoot(
    {
      "source-a/problem.json": JSON.stringify({
        number: 1001,
        title: "t",
        template: "../evil.py",
      }),
      "source-a/template.py": "print('safe')",
    },
    async (srcRoot) => {
      const tpl = await getProblemTemplate(
        { number: 1001, title: "t" },
        srcRoot,
      );
      assertEquals(tpl?.content, "print('safe')");
    },
  );
});

Deno.test("getProblemTemplate: 模板文件缺失返回 null", async () => {
  await withTmpSrcRoot(
    {
      "source-a/problem.json": JSON.stringify({ number: 1001, title: "t" }),
    },
    async (srcRoot) => {
      assertEquals(
        await getProblemTemplate({ number: 1001, title: "t" }, srcRoot),
        null,
      );
    },
  );
});

Deno.test("getProblemTemplate: 同题号的其他题目不会串入模板", async () => {
  await withTmpSrcRoot(
    {
      "legacy/problem.json": JSON.stringify({
        number: 1001,
        title: "星港舱门",
      }),
      "legacy/template.py": "GATE_TEMPLATE",
      "imported-ab/problem.json": JSON.stringify({
        number: 1001,
        title: "A+B Problem",
      }),
      "imported-ab/template.py": "AB_TEMPLATE",
    },
    async (srcRoot) => {
      const tpl = await getProblemTemplate(
        { number: 1001, title: "A+B Problem" },
        srcRoot,
      );
      assertEquals(tpl?.content, "AB_TEMPLATE");
    },
  );
});

Deno.test("getProblemTemplate: 多个完全匹配的源码目录返回 null", async () => {
  await withTmpSrcRoot(
    {
      "source-a/problem.json": JSON.stringify({ number: 1001, title: "t" }),
      "source-a/template.py": "print('a')",
      "source-b/problem.json": JSON.stringify({ number: 1001, title: "t" }),
      "source-b/template.py": "print('b')",
    },
    async (srcRoot) => {
      assertEquals(
        await getProblemTemplate({ number: 1001, title: "t" }, srcRoot),
        null,
      );
    },
  );
});
