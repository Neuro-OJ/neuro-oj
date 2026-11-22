import { assertEquals } from "jsr:@std/assert@^1";
import { TEACHING_CAPABILITIES } from "../../../../shared/education-types.ts";

Deno.test("教学能力：域教练共享六项教学能力，不包含平台管理、教练任命或自行授权", () => {
  assertEquals(TEACHING_CAPABILITIES, [
    "progress:read",
    "submissions:read",
    "assignments:manage",
    "feedback:write",
    "help:manage",
    "students:manage",
  ]);
});
