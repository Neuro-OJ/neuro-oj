/**
 * 题包 builder 单元测试：只验证普通文件夹具的内存打包行为。
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { strToU8, unzipSync } from "npm:fflate@0.8.2";
import { buildProblemBundle } from "../../fixtures/problem-bundle.ts";

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("problem-bundle: 文本与二进制文件都按原名写入", () => {
  const binary = new Uint8Array([0, 1, 2, 255]);
  const archive = buildProblemBundle({
    "problem.json": '{"format_version":2}',
    "evaluate.py": "print('ok')",
    "assets/model.bin": binary,
  });
  const files = unzipSync(archive);
  assertEquals(text(files["problem.json"]!), '{"format_version":2}');
  assertEquals(text(files["evaluate.py"]!), "print('ok')");
  assertEquals(files["assets/model.bin"]!, binary);
});

Deno.test("problem-bundle: UTF-8 中文内容保持原样", () => {
  const archive = buildProblemBundle({ "statement.md": "求解两数之和" });
  assertEquals(text(unzipSync(archive)["statement.md"]!), "求解两数之和");
});

Deno.test("problem-bundle: 空题包与绝对路径直接失败", () => {
  assertThrows(() => buildProblemBundle({}), Error, "至少需要一个文件");
  assertThrows(
    () => buildProblemBundle({ "/etc/passwd": "x" }),
    Error,
    "相对路径",
  );
});

Deno.test("problem-bundle: Uint8Array 输入不被再次编码", () => {
  const raw = strToU8("plain");
  const archive = buildProblemBundle({ "a.txt": raw });
  assertEquals(unzipSync(archive)["a.txt"]!, raw);
});
