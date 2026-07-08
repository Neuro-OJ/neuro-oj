/**
 * Samples 解析器单测（issue #28）。
 *
 * 题目 description 是 Markdown 文本，约定使用 `## 样例输入` / `## 样例输出` 段
 * 标记可见样例。导入导出时需要把这些段单独抽出来。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { extractSamples } from "../../src/lib/samples.ts";

Deno.test("samples: 单样例（H2 标题，无编号）", () => {
  const md = `# 题目

题目描述文本。

## 样例输入

1 2

## 样例输出

3
`;
  assertEquals(extractSamples(md), [
    { input: "1 2", output: "3" },
  ]);
});

Deno.test("samples: 多样例（H2 标题 + 编号 #1/#2）", () => {
  const md = `## 样例输入 #1

1 2

## 样例输出 #1

3

## 样例输入 #2

4 5

## 样例输出 #2

9
`;
  assertEquals(extractSamples(md), [
    { input: "1 2", output: "3" },
    { input: "4 5", output: "9" },
  ]);
});

Deno.test("samples: H3 标题也支持", () => {
  const md = `### 样例输入

hello

### 样例输出

world
`;
  assertEquals(extractSamples(md), [
    { input: "hello", output: "world" },
  ]);
});

Deno.test("samples: 多行输入/输出", () => {
  const md = `## 样例输入

3
1 2
3 4

## 样例输出

3
1 3
6 4
`;
  assertEquals(extractSamples(md), [
    {
      input: "3\n1 2\n3 4",
      output: "3\n1 3\n6 4",
    },
  ]);
});

Deno.test("samples: 无样例段返回空数组", () => {
  const md = `# 题目

只有描述，没有样例段。
`;
  assertEquals(extractSamples(md), []);
});

Deno.test("samples: 仅输入无输出 → 跳过该对", () => {
  const md = `## 样例输入

1 2
`;
  // 配对失败，不应返回半成品
  assertEquals(extractSamples(md), []);
});

Deno.test("samples: 仅输出无输入 → 跳过", () => {
  const md = `## 样例输出

3
`;
  assertEquals(extractSamples(md), []);
});

Deno.test("samples: 输入后跟另一个输入 → 第一个 input 被丢弃", () => {
  const md = `## 样例输入

1

## 样例输入

2

## 样例输出

3
`;
  // 配对规则：输入必须紧跟输出；连续两个输入时第一个被忽略
  assertEquals(extractSamples(md), [
    { input: "2", output: "3" },
  ]);
});

Deno.test("samples: 大小写不敏感", () => {
  const md = `## 样例INPUT

1

## 样例OUTPUT

2
`;
  // 中文标题里大小写不常见，但英文混排也要能识别
  assertEquals(extractSamples(md), [
    { input: "1", output: "2" },
  ]);
});
