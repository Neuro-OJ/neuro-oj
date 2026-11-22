/** `deno task db:migrate` 参数解析：逻辑升级前需要只建 schema、不写默认配额。 */
import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { parseGatewayMigrateArgs } from "../src/db/migrate-cli.ts";

Deno.test("parseGatewayMigrateArgs: 默认写入配额，--schema-only 只建 schema", () => {
  assertEquals(parseGatewayMigrateArgs([]), { schemaOnly: false });
  assertEquals(parseGatewayMigrateArgs(["--schema-only"]), {
    schemaOnly: true,
  });
});

Deno.test("parseGatewayMigrateArgs: 未知参数与拼写错误直接拒绝", () => {
  assertThrows(
    () => parseGatewayMigrateArgs(["--schema_only"]),
    Error,
    "未知参数",
  );
  assertThrows(() => parseGatewayMigrateArgs(["--"]), Error, "未知参数");
});
