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
