/**
 * getProblemTemplate 单元测试（纯文件系统，无 DB 依赖）。
 *
 * 覆盖：manifest.template 缺省默认 template.py、自定义文件名、
 * manifest 损坏回退、非法值回退、模板文件缺失返回 null。
 * 通过注入 srcRoot 指向临时目录，不触碰真实 data/problems-src。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { getProblemTemplate } from "../../src/services/support-package.ts";

/**
 * 在临时目录中构造 problems-src 结构并执行断言，结束后清理。
 *
 * @param files 相对 srcRoot 的文件路径 → 内容（如 `1001/problem.json`）
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
      "1001/problem.json": JSON.stringify({ title: "t" }),
      "1001/template.py": "print('hello')",
    },
    async (srcRoot) => {
      const tpl = await getProblemTemplate(1001, srcRoot);
      assertEquals(tpl, { content: "print('hello')", language: "python3" });
    },
  );
});

Deno.test("getProblemTemplate: 显式 template 字段按自定义文件名读取", async () => {
  await withTmpSrcRoot(
    {
      "1001/problem.json": JSON.stringify({
        title: "t",
        template: "starter.py",
      }),
      "1001/starter.py": "print('starter')",
    },
    async (srcRoot) => {
      const tpl = await getProblemTemplate(1001, srcRoot);
      assertEquals(tpl?.content, "print('starter')");
    },
  );
});

Deno.test("getProblemTemplate: manifest 损坏时回退默认 template.py", async () => {
  await withTmpSrcRoot(
    {
      "1001/problem.json": "{broken json",
      "1001/template.py": "print('default')",
    },
    async (srcRoot) => {
      const tpl = await getProblemTemplate(1001, srcRoot);
      assertEquals(tpl?.content, "print('default')");
    },
  );
});

Deno.test("getProblemTemplate: 非法 template 值（路径穿越）回退默认名", async () => {
  await withTmpSrcRoot(
    {
      "1001/problem.json": JSON.stringify({
        title: "t",
        template: "../evil.py",
      }),
      "1001/template.py": "print('safe')",
    },
    async (srcRoot) => {
      const tpl = await getProblemTemplate(1001, srcRoot);
      assertEquals(tpl?.content, "print('safe')");
    },
  );
});

Deno.test("getProblemTemplate: 模板文件缺失返回 null", async () => {
  await withTmpSrcRoot(
    {
      "1001/problem.json": JSON.stringify({ title: "t" }),
    },
    async (srcRoot) => {
      assertEquals(await getProblemTemplate(1001, srcRoot), null);
    },
  );
});
