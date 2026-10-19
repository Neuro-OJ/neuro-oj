// @deno-types="npm:@types/markdown-it@14.2.0"
import MarkdownIt from "npm:markdown-it@14.3.0";
import { BadRequestError } from "../../../shared/base/errors.ts";
import type {
  AnnotationAnchor,
  AnnotationBlock,
} from "../../../shared/annotation-types.ts";

/** 原文内容指纹覆盖 UTF-8 字节；不依赖客户端可伪造的引用文字。 */
export async function annotationHash(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(hash),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}

/** Markdown 分块保留确定的块序号和来源行；格式标记不进入句子范围。 */
export function annotationBlocks(
  content: string,
  code = false,
): AnnotationBlock[] {
  const normalized = content.replace(/\r\n|\r/g, "\n");
  if (code) return [{ id: "file", text: normalized, start_line: 1 }];
  const md = new MarkdownIt({ html: true, breaks: true });
  const blocks: AnnotationBlock[] = [];
  for (const token of md.parse(normalized, {})) {
    let text = "";
    if (token.type === "inline") {
      text = (token.children ?? []).map((child) => {
        if (child.type === "softbreak" || child.type === "hardbreak") {
          return "\n";
        }
        return ["text", "code_inline", "image"].includes(child.type)
          ? child.content
          : "";
      }).join("");
    } else if (token.type === "fence" || token.type === "code_block") {
      text = token.content.replace(/\n$/, "");
    } else if (token.type === "html_block") {
      text = md.utils.unescapeAll(token.content.replace(/<[^>]*>/g, "")).trim();
    }
    if (text) {
      blocks.push({
        id: `block:${blocks.length}`,
        text,
        start_line: (token.map?.[0] ?? 0) + (token.type === "fence" ? 2 : 1),
      });
    }
  }
  return blocks;
}

/** 核验范围后由服务端生成引用与前后三行，客户端不能注入上下文。 */
export function annotationAnchor(
  blocks: AnnotationBlock[],
  input: { block_id: string; start: number; end: number },
): AnnotationAnchor {
  if (!input || typeof input !== "object") {
    throw new BadRequestError("需要批注选区");
  }
  const block = blocks.find((item) => item.id === input.block_id);
  const emptyLine = !!block && block.id === "file" &&
    input.start === input.end &&
    (input.start === 0 || block.text[input.start - 1] === "\n") &&
    (input.start === block.text.length || block.text[input.start] === "\n");
  if (
    !block || !Number.isSafeInteger(input.start) ||
    !Number.isSafeInteger(input.end) || input.start < 0 ||
    input.end < input.start || input.end === input.start && !emptyLine ||
    input.end > block.text.length || input.end - input.start > 30000
  ) {
    throw new BadRequestError(
      "批注范围无效，请重新选择原文",
      "ANNOTATION_RANGE_INVALID",
    );
  }
  for (const offset of [input.start, input.end]) {
    if (
      offset && /[\uD800-\uDBFF]/.test(block.text[offset - 1]!) &&
      /[\uDC00-\uDFFF]/.test(block.text[offset] ?? "")
    ) throw new BadRequestError("批注范围不能拆分字符");
  }
  const prefix = block.text.slice(0, input.start),
    suffix = block.text.slice(input.end);
  return {
    block_id: input.block_id,
    start: input.start,
    end: input.end,
    quote: block.text.slice(input.start, input.end),
    before: prefix.split("\n").slice(-4).join("\n").slice(-8192),
    after: suffix.split("\n").slice(0, 4).join("\n").slice(0, 8192),
    start_line: block.start_line + prefix.split("\n").length - 1,
    end_line: block.start_line +
      block.text.slice(0, input.end).split("\n").length - 1,
  };
}
