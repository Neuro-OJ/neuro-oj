import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  domainPermissions,
  presetConfiguration,
  validateDomainConfiguration,
  validateDomainSlug,
} from "../../types.ts";
import { BadRequestError } from "../../../../../shared/base/errors.ts";
import { effectiveDomainConfiguration } from "../../../../../shared/workspace/capabilities.ts";

Deno.test("工作空间：域管理员不能获得平台权限，单角色决定域能力", () => {
  const admin = domainPermissions("admin");
  assert(admin.has("llm:manage"));
  assert(!admin.has("admin:full_access"));
  assert(!admin.has("domain:transfer"));
  assert(domainPermissions("owner").has("domain:transfer"));
  assert(!domainPermissions("member").has("submission:read_all"));
  assert(domainPermissions("educator").has("classroom:manage_any"));
  assert(!domainPermissions("educator").has("domain:invitations"));
  // 无成员关系得到空能力集，不默认成 member。
  assertEquals(domainPermissions(null).size, 0);
});
Deno.test("工作空间：三种类型均有社区和排行，仅教学类型提供教学，旧开关不改变能力", () => {
  for (const type of ["community", "education", "team"] as const) {
    const config = presetConfiguration(type);
    assertEquals(config.features.community, true);
    assertEquals(config.features.analytics, true);
    assertEquals(config.features.classroom, type === "education");
    assertEquals(config.features.assignment, type === "education");
  }
  const config = presetConfiguration("team");
  config.features.classroom = true;
  config.features.assignment = true;
  config.features.community = false;
  const effective = effectiveDomainConfiguration("team", config);
  assertEquals(effective.features.classroom, false);
  assertEquals(effective.features.assignment, false);
  assertEquals(effective.features.community, true);
  assertEquals(presetConfiguration("team").features.classroom, false);
});
Deno.test("工作空间：拒绝路径、跨域分隔符和错误模块依赖", () => {
  for (
    const slug of [
      "School",
      "a",
      "../main",
      "main:1001",
      "school/other",
      "school-",
      "a".repeat(33),
    ]
  ) assertThrows(() => validateDomainSlug(slug), BadRequestError);
  validateDomainSlug("school-a");
  const invalid = presetConfiguration("team");
  invalid.features.assignment = true;
  assertThrows(() => validateDomainConfiguration(invalid), BadRequestError);
});
