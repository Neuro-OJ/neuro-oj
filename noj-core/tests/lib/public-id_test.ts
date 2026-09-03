import { assert, assertEquals, assertFalse } from "jsr:@std/assert@^1";
import {
  generatePublicId,
  isPublicId,
  isUuid,
} from "./../../src/shared/security/public-id.ts";

Deno.test("public-id: isUuid 识别标准 UUID", () => {
  assert(
    isUuid("3f2b8c1e-1a2b-4c3d-8e4f-9a0b1c2d3e4f"),
  );
  assertFalse(isUuid("ct-8f3k2xq"));
  assertFalse(isUuid(""));
});

Deno.test("public-id: generatePublicId 使用前缀与字符集", () => {
  const id = generatePublicId("ct");
  assertEquals(id.slice(0, 3), "ct-");
  assertEquals(id.length, 11);
  assert(isPublicId(id, "ct"));
});

Deno.test("public-id: isPublicId 拒绝非法字符和长度", () => {
  assertFalse(isPublicId("ct-0O1Il", "ct"));
  assertFalse(isPublicId("ct-1234567", "ct"));
  assertFalse(isPublicId("ct-123456789", "ct"));
  assertFalse(isPublicId("tr-8f3k2xq", "ct"));
});
