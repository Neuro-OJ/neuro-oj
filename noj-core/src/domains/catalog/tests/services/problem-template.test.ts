/**
 * 模板解析单元测试（纯文件系统 + 纯内存，无 DB 依赖）。
 *
 * 覆盖：manifest.template 缺省默认 template.py、自定义文件名、manifest 损坏回退、
 * 非法值回退、模板文件缺失返回 null、**manifest 未声明 number 时按标题匹配**
 * （导入时题号由平台自增分配，出题人本地 manifest 普遍不写 number，旧规则会让
 * 这些题目的模板永远读不到）、从已存储支持包 zip 内提取模板，以及导入时从题包
 * 条目读取模板（readBundleTemplate，含自定义名/非法名回退/超限）。
 * 通过注入 srcRoot 指向临时目录，不触碰真实 data/problems-src。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { zipSync } from "fflate";
import {
  extractTemplateFromPackage,
  getProblemTemplate,
  readBundleTemplate,
} from "../../index.ts";

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

Deno.test("getProblemTemplate: manifest 未声明 number 时按标题匹配（线上题号由平台分配）", async () => {
  // 复现线上 P5 的场景：题包 manifest 没有 number（导入时自增分配为 5），
  // 旧规则 `manifest.number === problem.number` 恒不等 → 模板永远 404。
  await withTmpSrcRoot(
    {
      "trial-snowy-manor/problem.json": JSON.stringify({
        format_version: 1,
        type: "P",
        title: "魔法 Agents 的推理审判",
        template: "template.py",
      }),
      "trial-snowy-manor/template.py": "SKELETON",
    },
    async (srcRoot) => {
      const tpl = await getProblemTemplate(
        { number: 5, title: "魔法 Agents 的推理审判" },
        srcRoot,
      );
      assertEquals(tpl?.content, "SKELETON");
    },
  );
});

Deno.test("getProblemTemplate: 标题相同但 manifest 题号不同 → 不匹配", async () => {
  await withTmpSrcRoot(
    {
      "other/problem.json": JSON.stringify({ number: 7, title: "同名题" }),
      "other/template.py": "WRONG",
    },
    async (srcRoot) => {
      assertEquals(
        await getProblemTemplate({ number: 5, title: "同名题" }, srcRoot),
        null,
      );
    },
  );
});

Deno.test("getProblemTemplate: 声明与未声明 number 的同名目录共存时返回 null（归属不唯一）", async () => {
  await withTmpSrcRoot(
    {
      "with-number/problem.json": JSON.stringify({
        number: 5,
        title: "同名题",
      }),
      "with-number/template.py": "A",
      "without-number/problem.json": JSON.stringify({ title: "同名题" }),
      "without-number/template.py": "B",
    },
    async (srcRoot) => {
      assertEquals(
        await getProblemTemplate({ number: 5, title: "同名题" }, srcRoot),
        null,
      );
    },
  );
});

Deno.test("extractTemplateFromPackage: 从支持包 zip 中取出 template.py", () => {
  const enc = new TextEncoder();
  const zip = zipSync({
    "evaluate.py": enc.encode("print('evaluator')"),
    "template.py": enc.encode("PACKAGE_SKELETON"),
    "visible.jsonl": enc.encode("{}\n"),
  });
  assertEquals(extractTemplateFromPackage(zip), "PACKAGE_SKELETON");
});

Deno.test("extractTemplateFromPackage: 兼容 ./template.py 前缀形式", () => {
  const enc = new TextEncoder();
  const zip = zipSync({
    "./evaluate.py": enc.encode("print('evaluator')"),
    "./template.py": enc.encode("DOT_SLASH"),
  });
  assertEquals(extractTemplateFromPackage(zip), "DOT_SLASH");
});

Deno.test("extractTemplateFromPackage: 包内无模板返回 null", () => {
  const enc = new TextEncoder();
  const zip = zipSync({ "evaluate.py": enc.encode("print('evaluator')") });
  assertEquals(extractTemplateFromPackage(zip), null);
});

Deno.test("extractTemplateFromPackage: 非法 zip 字节返回 null（不抛错）", () => {
  assertEquals(extractTemplateFromPackage(new Uint8Array([1, 2, 3, 4])), null);
});

Deno.test("extractTemplateFromPackage: 超过大小上限的模板不返回", () => {
  const enc = new TextEncoder();
  const zip = zipSync({
    "evaluate.py": enc.encode("print('evaluator')"),
    // 256 KiB + 1 字节 → 超过 MAX_TEMPLATE_BYTES
    "template.py": enc.encode("x".repeat(256 * 1024 + 1)),
  });
  assertEquals(extractTemplateFromPackage(zip), null);
});

Deno.test("readBundleTemplate: manifest 声明的自定义文件名按条目读取", () => {
  const enc = new TextEncoder();
  const entries = {
    "problem.json": enc.encode("{}"),
    "starter.py": enc.encode("CUSTOM_SKELETON"),
  };
  assertEquals(readBundleTemplate(entries, "starter.py"), {
    status: "ok",
    content: "CUSTOM_SKELETON",
  });
});

Deno.test("readBundleTemplate: 未声明文件名时按默认 template.py 读取", () => {
  const enc = new TextEncoder();
  const entries = { "template.py": enc.encode("DEFAULT_SKELETON") };
  assertEquals(readBundleTemplate(entries, undefined), {
    status: "ok",
    content: "DEFAULT_SKELETON",
  });
});

Deno.test("readBundleTemplate: 非法文件名（路径穿越）回退默认名，不读包外条目", () => {
  const enc = new TextEncoder();
  const entries = { "template.py": enc.encode("SAFE") };
  assertEquals(readBundleTemplate(entries, "../evil.py"), {
    status: "ok",
    content: "SAFE",
  });
  assertEquals(readBundleTemplate(entries, "sub/evil.py"), {
    status: "ok",
    content: "SAFE",
  });
});

Deno.test("readBundleTemplate: 兼容 ./template.py 前缀形式", () => {
  const enc = new TextEncoder();
  assertEquals(
    readBundleTemplate({ "./template.py": enc.encode("DOT_SLASH") }),
    { status: "ok", content: "DOT_SLASH" },
  );
});

Deno.test("readBundleTemplate: 条目缺失返回 missing", () => {
  assertEquals(readBundleTemplate({}), { status: "missing" });
});

Deno.test("readBundleTemplate: 超过大小上限返回 too_large（附实际大小）", () => {
  const size = 256 * 1024 + 1;
  const entries = { "template.py": new Uint8Array(size) };
  assertEquals(readBundleTemplate(entries), { status: "too_large", size });
});
