/**
 * check-env 一致性校验测试。
 *
 * 覆盖 inspectConsistency 的三个分支：
 * - 可见 bootstrap 键缺失于 .env.example → 报告；
 * - 孤儿键（注册表未登记）→ 报告；
 * - 编排级键白名单 → 豁免。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { inspectConsistency } from "../../scripts/check-env.ts";
import {
  CONFIG_DEFINITIONS,
  validateRegistry,
} from "../../src/shared/config/settings-registry.ts";

function registryEnvKeys(): string[] {
  return CONFIG_DEFINITIONS
    .map((d) => (d.scope === "bootstrap" ? d.envKey : d.envFallback))
    .filter((k): k is string => Boolean(k));
}

Deno.test({
  name: "check-env: inspectConsistency 报告缺失的可见 bootstrap 键",
  fn: () => {
    const findings = inspectConsistency(
      registryEnvKeys(),
      new Set(["JWT_SECRET", "PORT"]),
    );
    // 当前注册表 bootstrap 可见键远多于 2 个，必然有缺失报告
    assertEquals(findings.some((f) => f.key === "STORAGE_PROVIDER"), true);
    assertEquals(findings.some((f) => f.key === "JWT_SECRET"), false);
  },
});

Deno.test({
  name: "check-env: inspectConsistency 报告孤儿键（注册表未登记）",
  fn: () => {
    const findings = inspectConsistency(
      registryEnvKeys(),
      new Set(["SOME_ORPHAN_KEY_XYZ"]),
    );
    assertEquals(
      findings.some((f) => f.key === "SOME_ORPHAN_KEY_XYZ"),
      true,
    );
  },
});

Deno.test({
  name: "check-env: inspectConsistency 豁免编排级键",
  fn: () => {
    const findings = inspectConsistency(
      registryEnvKeys(),
      new Set(["POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD", "NOJ_VERSION"]),
    );
    assertEquals(
      findings.some((f) => f.key === "POSTGRES_PASSWORD"),
      false,
    );
    assertEquals(findings.some((f) => f.key === "NOJ_VERSION"), false);
  },
});

Deno.test({
  name: "check-env: 注册表自身合法（validateRegistry 通过）",
  fn: () => {
    validateRegistry();
  },
});
