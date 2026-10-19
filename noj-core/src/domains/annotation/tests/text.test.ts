import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  annotationAnchor,
  annotationBlocks,
  annotationHash,
} from "../services/text.ts";
import { annotationIsPlainText } from "../../../shared/annotation-types.ts";

Deno.test("批注定位：Markdown 格式、重复句子、中文及代码块保持稳定块身份", () => {
  const text =
    "# 标题\n\n第一句 **重点**，见[链接](https://example.com)。\n\n重复。\n\n重复。\n\n```py\nprint(1)\n```";
  const blocks = annotationBlocks(text);
  assertEquals(blocks.map((b) => b.text), [
    "标题",
    "第一句 重点，见链接。",
    "重复。",
    "重复。",
    "print(1)",
  ]);
  assertEquals(
    annotationAnchor(blocks, { block_id: "block:3", start: 0, end: 3 }).quote,
    "重复。",
  );
  assertEquals(
    annotationAnchor(blocks, { block_id: "block:4", start: 0, end: 8 })
      .start_line,
    10,
  );
});
Deno.test("批注定位：原始字节指纹区分换行，代码范围按统一行号计算", async () => {
  assertEquals(
    await annotationHash("a\r\nb") === await annotationHash("a\nb"),
    false,
  );
  const blocks = annotationBlocks("a\r\nb\r\nc\r\nd\r\ne\r\nf", true);
  const anchor = annotationAnchor(blocks, {
    block_id: "file",
    start: 6,
    end: 7,
  });
  assertEquals(anchor.quote, "d");
  assertEquals(anchor.start_line, 4);
  assertEquals(anchor.before, "a\nb\nc\n");
  assertEquals(anchor.after, "\ne\nf");
});
Deno.test("批注定位：拒绝越界、伪造块和拆分 Emoji，客户端上下文不进入可信引用", () => {
  const blocks = annotationBlocks("学生😀提问", true);
  for (
    const input of [
      { block_id: "other", start: 0, end: 1 },
      { block_id: "file", start: -1, end: 1 },
      { block_id: "file", start: 0, end: 99 },
      { block_id: "file", start: 2, end: 3 },
    ]
  ) {
    assertThrows(() => annotationAnchor(blocks, input), BadRequestError);
  }
  assertEquals(
    annotationAnchor(blocks, { block_id: "file", start: 2, end: 4 }).quote,
    "😀",
  );
});
Deno.test("批注定位：空代码行可以定位，普通文本的空范围仍然拒绝", () => {
  const blocks = annotationBlocks("a\n\nb", true);
  assertEquals(
    annotationAnchor(blocks, { block_id: "file", start: 2, end: 2 }).start_line,
    2,
  );
  assertEquals(
    annotationAnchor(blocks, { block_id: "file", start: 2, end: 2 }).quote,
    "",
  );
  assertThrows(
    () =>
      annotationAnchor(annotationBlocks("正文"), {
        block_id: "block:0",
        start: 0,
        end: 0,
      }),
    BadRequestError,
  );
});

Deno.test("批注定位：样例输入输出保留 Markdown 符号与空白，解释仍按 Markdown 解析", () => {
  const target = {
    kind: "problem" as const,
    reference: "1001",
    field: "samples.0.input",
  };
  assertEquals(
    annotationBlocks("# value\n  * 3", annotationIsPlainText(target))[0]!.text,
    "# value\n  * 3",
  );
  assertEquals(
    annotationIsPlainText({ ...target, field: "samples.0.explanation" }),
    false,
  );
});
