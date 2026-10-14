import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  allowedDomainFeatures,
  combineDomainLimits,
  constrainDomainConfiguration,
  unlimitedDomainLimits,
  validateDomainFeatures,
  validateDomainLimits,
} from "../../../../shared/workspace/resource-policy.ts";
import { presetConfiguration } from "../../types.ts";

Deno.test("资源政策：null 与零的意义不同，域与实例限制逐项取严格值", () => {
  const local = { ...unlimitedDomainLimits(), members: 10, problems: 0 };
  const caps = { ...unlimitedDomainLimits(), members: 5, storage_bytes: 100 };
  assertEquals(combineDomainLimits(local, caps), {
    members: 5,
    problems: 0,
    storage_bytes: 100,
    submissions_per_minute: null,
  });
  assertEquals(unlimitedDomainLimits().members, null);
});
Deno.test("资源政策：拒绝缺字段、未知字段、负数、非整数及数据库溢出", () => {
  for (
    const invalid of [
      {},
      { ...unlimitedDomainLimits(), secret: true },
      { ...unlimitedDomainLimits(), members: -1 },
      { ...unlimitedDomainLimits(), storage_bytes: 0.1 },
      { ...unlimitedDomainLimits(), members: 2147483648 },
      {
        ...unlimitedDomainLimits(),
        storage_bytes: Number.MAX_SAFE_INTEGER + 1,
      },
    ]
  ) assertThrows(() => validateDomainLimits(invalid));
  validateDomainLimits({
    ...unlimitedDomainLimits(),
    storage_bytes: Number.MAX_SAFE_INTEGER,
  });
});
Deno.test("模块政策：初始化受实例限制，依赖和首页同步收敛，不修改原配置", () => {
  const preset = presetConfiguration("education");
  const allowed = {
    ...allowedDomainFeatures(),
    classroom: false,
    assignment: false,
    analytics: false,
  };
  const constrained = constrainDomainConfiguration(preset, allowed);
  assertEquals(constrained.features.classroom, false);
  assertEquals(constrained.homepage, "overview");
  assertEquals(preset.features.classroom, true);
  assertThrows(() =>
    validateDomainFeatures({ ...allowedDomainFeatures(), classroom: false })
  );
});
