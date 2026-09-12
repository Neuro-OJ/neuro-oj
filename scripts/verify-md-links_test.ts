// 文档链接门禁脚本测试。
import {
  collectHeadings,
  extractLinks,
  verifyMarkdownLinks,
} from "./verify-md-links.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

function withTempDir(
  files: Record<string, string>,
  fn: (dir: string) => void,
): void {
  const dir = Deno.makeTempDirSync({ prefix: "md-links-test-" });
  try {
    for (const [rel, content] of Object.entries(files)) {
      const filePath = `${dir}/${rel}`;
      const parent = filePath.slice(0, filePath.lastIndexOf("/"));
      Deno.mkdirSync(parent, { recursive: true });
      Deno.writeTextFileSync(filePath, content);
    }
    fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("extractLinks 提取相对链接与锚点", () => {
  const links = extractLinks(`[b](b.md) [锚点](#section) ![img](img.png)`);
  assert(links.length === 3, `应提取 3 个链接，实际 ${links.length}`);
});

Deno.test("extractLinks 跳过围栏代码块与行内代码", () => {
  // 回归：文档里引用代码示例（含 `](...)`）会被误判为链接。
  // 实测触发场景：架构评审文档引用路由提取正则后，本门禁报"目标文件不存在"。
  const content = [
    "```ts",
    "const re = /\\.(get|post)\\(\\s*[\"'`]([^\"'`]+)[\"'`]/g;",
    "```",
    "行内示例：`[x](no-such.md)` 不是链接",
    "",
    "[real](b.md)",
  ].join("\n");
  const links = extractLinks(content);
  assert(links.length === 1, `代码块内不应提取链接，实际 ${links.length}`);
  assert(links[0].target === "b.md", "应只提取真实链接");
  assert(links[0].line === 6, `行号应保持，实际 ${links[0].line}`);
});

Deno.test("verifyMarkdownLinks 不因代码块内容误报", () => {
  withTempDir({
    "a.md": [
      "```js",
      "const re = /x](y.md)/;",
      "```",
      "",
      "[b](b.md)",
    ].join("\n"),
    "b.md": "# B\n",
  }, (dir) => {
    const errors = verifyMarkdownLinks(dir);
    assert(errors.length === 0, `不应误报，实际: ${errors.join("; ")}`);
  });
});

Deno.test("有效相对链接与锚点通过", () => {
  withTempDir({
    "a.md": `[b](b.md)\n[b-section](b.md#section)\n[same](#own)\n\n## Own\n`,
    "b.md": `## Section\n`,
  }, (dir) => {
    const errors = verifyMarkdownLinks(dir);
    assert(errors.length === 0, `应无错误，实际: ${errors.join("; ")}`);
  });
});

Deno.test("缺失目标文件报错", () => {
  withTempDir({
    "a.md": `[missing](no-such.md)\n`,
  }, (dir) => {
    const errors = verifyMarkdownLinks(dir);
    assert(errors.length > 0, "应报错");
    assert(errors[0].includes("no-such.md"), "错误应包含缺失文件");
  });
});

Deno.test("缺失锚点报错", () => {
  withTempDir({
    "a.md": `[bad](b.md#nope)\n`,
    "b.md": `## Section\n`,
  }, (dir) => {
    const errors = verifyMarkdownLinks(dir);
    assert(errors.length > 0, "应报错");
    assert(errors[0].includes("#nope"), "错误应包含缺失锚点");
  });
});

Deno.test("collectHeadings 收集显式锚点与 slug", () => {
  withTempDir({
    "h.md": `# Title\n## Section {#custom}\n### Another Section\n`,
  }, (dir) => {
    const headings = collectHeadings(`${dir}/h.md`);
    assert(headings.has("custom"), "应包含显式锚点 custom");
    assert(headings.has("another-section"), "应包含 slug another-section");
  });
});
