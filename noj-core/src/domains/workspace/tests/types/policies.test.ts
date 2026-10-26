import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  configurationDiff,
  domainPermissions,
  presetConfiguration,
  validateDomainConfiguration,
  validateDomainSlug,
} from "../../types.ts";
import { BadRequestError } from "../../../../shared/base/errors.ts";

Deno.test("工作空间：管理员不能获得平台权限，角色组合只扩展当前域能力", () => {
  const admin = domainPermissions(["admin"]);
  assert(admin.has("llm:manage"));
  assert(!admin.has("admin:full_access"));
  assert(!admin.has("domain:transfer"));
  assert(domainPermissions(["owner"]).has("domain:transfer"));
  assert(!domainPermissions(["editor"]).has("submission:read_all"));
  assert(!domainPermissions(["educator"]).has("classroom:manage_any"));
  assert(domainPermissions(["editor", "educator"]).has("classroom:create"));
  assertEquals(domainPermissions([]).size, 0);
});
Deno.test("工作空间：模板配置独立，可在团队域启用教学，差异不操作业务数据", () => {
  const config = presetConfiguration("team");
  config.features.classroom = true;
  config.features.assignment = true;
  validateDomainConfiguration(config);
  assertEquals(presetConfiguration("team").features.classroom, false);
  const diff = configurationDiff(config, presetConfiguration("custom"));
  assert(diff.some((item) => item.key === "features.classroom"));
  assertEquals(config.features.classroom, true);
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
  const invalid = presetConfiguration("custom");
  invalid.features.assignment = true;
  assertThrows(() => validateDomainConfiguration(invalid), BadRequestError);
});
