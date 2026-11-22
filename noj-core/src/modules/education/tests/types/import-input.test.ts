import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import { parseClassroomImport } from "../../services/import-input.ts";

Deno.test("班级 CSV：标准引号、BOM 和 CRLF，逐行保留无效邮箱与列数错误", () => {
  const rows = parseClassroomImport(
    '\uFEFFemail,username,note\r\nA@EXAMPLE.com,alice,"带逗号,的备注"\r\ninvalid,bob,note\r\nx@example.com,x\r\n',
  );
  assertEquals(rows[0], { row: 2, email: "a@example.com", username: "alice" });
  assertEquals(rows[1].error, "邮箱格式错误");
  assertEquals(rows[2].error, "列数与表头不一致");
  assertEquals(parseClassroomImport("username\nalice")[0].username, "alice");
});
Deno.test("班级 CSV：最多 500 条，不接受重复表头、空批次和非法引号", () => {
  assertEquals(
    parseClassroomImport(
      "email\n" +
        Array.from({ length: 500 }, (_, i) => `${i}@example.com`).join("\n"),
    ).length,
    500,
  );
  for (
    const csv of [
      "email,email\nx@example.com,y@example.com",
      "note\nabc",
      "email\n",
      'email\n"unclosed',
      "email\n" +
      Array.from({ length: 501 }, (_, i) => `${i}@example.com`).join("\n"),
    ]
  ) {
    assertThrows(() => parseClassroomImport(csv), BadRequestError);
  }
});
