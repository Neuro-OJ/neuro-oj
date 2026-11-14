/**
 * 讲解文档读取与目录穿越防护（经 `deno task test:domain knowledge` 运行）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { join } from "jsr:@std/path@^1";
import {
  normalizePackRelativePath,
  readDocMarkdown,
  resolveDocsDir,
} from "./pack.ts";

Deno.test("knowledge doc: 读取内容包 docs 下的讲解原文", async () => {
  const dir = resolveDocsDir();
  const files = [...Deno.readDirSync(dir)].filter((entry) =>
    entry.isFile && entry.name.endsWith(".md")
  );
  if (files.length === 0) return; // 试点内容晚于本阶段时跳过
  const text = await readDocMarkdown(`docs/${files[0]!.name}`);
  if (text === null) {
    throw new Error(`读取失败：${files[0]!.name}（docs=${dir}）`);
  }
  assertEquals(text.length > 0, true);
});

Deno.test("knowledge doc: 未声明或文件缺失返回 null", async () => {
  assertEquals(await readDocMarkdown(null), null);
  assertEquals(await readDocMarkdown("docs/__no_such_doc__.md"), null);
});

Deno.test("knowledge doc: 目录穿越与非法路径被拒绝", async () => {
  for (
    const path of [
      "../package.json",
      "docs/../../deno.json",
      "/etc/passwd",
      "docs/..",
      "docs//x.md",
      "docs\\..\\x.md",
      "docs/\0x.md",
    ]
  ) {
    assertEquals(await readDocMarkdown(path), null, `应拒绝：${path}`);
  }
  // 规范化函数单独校验。
  assertEquals(normalizePackRelativePath("docs/a.md"), "docs/a.md");
  assertEquals(normalizePackRelativePath("./docs/a.md"), "docs/a.md");
  assertEquals(normalizePackRelativePath("docs/../a.md"), null);
  assertEquals(normalizePackRelativePath("../a.md"), null);
  assertEquals(normalizePackRelativePath(""), null);
  // 确认阻止的不是"文件不存在"而是路径越界：越界目标文件确实存在。
  const realFile = join(resolveDocsDir(), "..", "pack.yaml");
  assertEquals((await Deno.stat(realFile)).isFile, true);
  assertEquals(await readDocMarkdown("pack.yaml"), null);
});
