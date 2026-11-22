import { assertEquals } from "@std/assert";
import type { PromptIO } from "./io.ts";
import { confirm, input, secretInput, select } from "./widgets.ts";

/** 可编程 fake IO：按序消费 answers，记录 writes。 */
class FakeIO implements PromptIO {
  writes: string[] = [];
  answers: string[];
  constructor(answers: string[]) {
    this.answers = answers;
  }
  write(text: string): void {
    this.writes.push(text);
  }
  readLine(_prompt: string): Promise<string> {
    return Promise.resolve(this.answers.shift() ?? "");
  }
  readSecret(_prompt: string): Promise<string> {
    return Promise.resolve(this.answers.shift() ?? "");
  }
}

Deno.test("select: 返回所选编号并打印选项", async () => {
  const io = new FakeIO(["2"]);
  const idx = await select(io, "选择模式", ["dev", "prod"]);
  assertEquals(idx, 1);
  assertEquals(io.writes.join("").includes("prod"), true);
});

Deno.test("select: 非法输入重试后成功", async () => {
  const io = new FakeIO(["9", "1"]);
  const idx = await select(io, "选择模式", ["dev", "prod"]);
  assertEquals(idx, 0);
});

Deno.test("input: 空输入返回默认值", async () => {
  const io = new FakeIO([""]);
  assertEquals(await input(io, "端口", "8080"), "8080");
});

Deno.test("input: 非空输入原样返回", async () => {
  const io = new FakeIO(["9000"]);
  assertEquals(await input(io, "端口", "8080"), "9000");
});

Deno.test("secretInput: 返回密钥且空输入重试", async () => {
  const io = new FakeIO(["", "s3cr3t"]);
  assertEquals(await secretInput(io, "密码"), "s3cr3t");
});

Deno.test("confirm: y/n 与默认值", async () => {
  assertEquals(await confirm(new FakeIO(["y"]), "继续?", false), true);
  assertEquals(await confirm(new FakeIO(["n"]), "继续?", true), false);
  assertEquals(await confirm(new FakeIO([""]), "继续?", true), true);
});
