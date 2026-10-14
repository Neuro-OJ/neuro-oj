import { assertEquals, assertRejects } from "@std/assert";
import { collectSecret } from "./io.ts";

/** 模拟原始模式：每次 read 只交付一个块（默认一个按键）。 */
function reader(chunks: (string | number[])[]) {
  const enc = new TextEncoder();
  const queue = chunks.map((c) =>
    typeof c === "string" ? enc.encode(c) : new Uint8Array(c)
  );
  return (buf: Uint8Array) => {
    const next = queue.shift();
    if (!next) return Promise.resolve(null);
    buf.set(next);
    return Promise.resolve(next.length);
  };
}

Deno.test("collectSecret: 逐键读取直到回车（含大写字母与数字）", async () => {
  // 回归：原实现只读一次，原始模式下只拿到第一个字符，其余按键泄漏给 shell
  assertEquals(await collectSecret(reader([..."Ab9Z!x", "\r"])), "Ab9Z!x");
});

Deno.test("collectSecret: Backspace 按 UTF-8 回退一个字符", async () => {
  assertEquals(
    await collectSecret(reader(["密", "码", "x", [0x7f], [0x7f], "y\r"])),
    "密y",
  );
});

Deno.test("collectSecret: 跳过方向键与括号粘贴标记，粘贴整段可用", async () => {
  assertEquals(
    await collectSecret(reader(["\x1b[D", "\x1b[200~pa55word\x1b[201~", "\n"])),
    "pa55word",
  );
});

Deno.test("collectSecret: Ctrl-C 取消，Ctrl-D 空输入结束", async () => {
  await assertRejects(
    () => collectSecret(reader(["ab", [0x03]])),
    Error,
    "已取消",
  );
  assertEquals(await collectSecret(reader([[0x04]])), "");
});
