import { assertEquals } from "jsr:@std/assert@^1";
import { ASSISTANT_CAPABILITIES } from "../../../../shared/education-types.ts";

Deno.test("教学能力：六项固定能力，不包含平台管理、教练任命或自行授权", () => {
  assertEquals(ASSISTANT_CAPABILITIES, [
    "progress:read",
    "submissions:read",
    "assignments:manage",
    "feedback:write",
    "help:manage",
    "students:manage",
  ]);
});
