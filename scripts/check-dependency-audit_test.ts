import { assertEquals } from "jsr:@std/assert@^1";
import {
  bulkRequestBody,
  isIgnored,
  lockedVersions,
} from "./check-dependency-audit.ts";

Deno.test("lockedVersions：从 deno.lock 提取精确锁定版本", () => {
  const versions = lockedVersions({
    npm: {
      "dompurify@3.4.17": { integrity: "x" },
      "@scope/pkg@1.2.3_peer@4.5.6": { integrity: "y" },
    },
  });
  assertEquals([...(versions.get("dompurify") ?? [])], ["3.4.17"]);
  assertEquals([...(versions.get("@scope/pkg") ?? [])], ["1.2.3"]);
});

Deno.test("bulkRequestBody：包名映射到版本数组（bulk 接口形状）", () => {
  const body = bulkRequestBody(new Map([["a", new Set(["1.0.0", "2.0.0"])]]));
  assertEquals(body, { a: ["1.0.0", "2.0.0"] });
});

Deno.test("isIgnored：按被查询包名匹配，过期条目失效", () => {
  const advisory = {
    id: 1,
    url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
    title: "t",
    severity: "critical" as const,
    vulnerable_versions: "<1",
    name: "upstream-different-name",
  };
  const entry = {
    advisory: "GHSA-aaaa-bbbb-cccc",
    package: "queried-pkg",
    scope: "build" as const,
    reason: "r",
    review_by: "2026-06-01",
  };
  // 未过期：命中
  assertEquals(
    isIgnored("m", "queried-pkg", advisory, [entry], new Date("2026-01-01")) !==
      null,
    true,
  );
  // 已过期：不再覆盖
  assertEquals(
    isIgnored("m", "queried-pkg", advisory, [entry], new Date("2026-12-01")),
    null,
  );
  // 包名不匹配：不覆盖（即使响应里的 name 相同）
  assertEquals(
    isIgnored("m", "other", advisory, [entry], new Date("2026-01-01")),
    null,
  );
});
