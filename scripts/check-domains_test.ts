import {
  checkAdminObservabilityReadSide,
  checkFile,
  domainOf,
  resolveRelativeImport,
} from "./check-domains.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

function assertEquals<T>(actual: T, expected: T): void {
  assert(
    actual === expected,
    `expected ${String(expected)}, got ${String(actual)}`,
  );
}

Deno.test("domainOf: 遗留 auth 目录映射到 identity", () => {
  assertEquals(domainOf("noj-core/src/services/auth/auth.ts"), "identity");
});

Deno.test("domainOf: contest 服务目录映射到 contest", () => {
  assertEquals(
    domainOf("noj-core/src/services/contest/contests.ts"),
    "contest",
  );
});

Deno.test("domainOf: 顶层 notifications.ts 映射到 community", () => {
  assertEquals(domainOf("noj-core/src/services/notifications.ts"), "community");
});

Deno.test("domainOf: 非域文件返回 null", () => {
  assertEquals(domainOf("noj-core/src/lib/errors.ts"), null);
});

Deno.test("resolveRelativeImport: 解析相对导入到仓库相对路径", () => {
  const target = resolveRelativeImport(
    "noj-core/src/services/contest/contests.ts",
    "../submissions/submissions.ts",
  );
  assertEquals(target, "noj-core/src/services/submissions/submissions.ts");
});

Deno.test("checkFile: 跨域深路径导入报违规", () => {
  const violations = checkFile(
    "noj-core/src/services/contest/contests.ts",
    `import { listSubmissions } from "../submissions/submissions.ts";\n`,
  );
  assertEquals(violations.length, 1);
  assertEquals(
    violations[0]!.target,
    "noj-core/src/services/submissions/submissions.ts",
  );
});

Deno.test("checkFile: 同域相对导入不报违规", () => {
  const violations = checkFile(
    "noj-core/src/services/contest/contest-ranking.ts",
    `import { getContest } from "./contests.ts";\n`,
  );
  assert(violations.length === 0, "应无违规");
});

Deno.test("checkFile: 允许未来域门面 index.ts 导入", () => {
  const violations = checkFile(
    "noj-core/src/services/contest/contests.ts",
    `import { listSubmissions } from "../domains/submission/index.ts";\n`,
  );
  assert(violations.length === 0, "应允许域门面导入");
});

Deno.test("checkFile: 业务域 import observability/index.ts 违规（spec §4.5 规则 2）", () => {
  // 该不变量此前**未被实现**：isPublicDomainImport 对任何 index.ts 无条件放行，
  // 不看 sourceDomain，因此 submission → observability/index.ts 被判合规，
  // 而 spec 与 domain-boundaries.md 都写明该 import 仅 admin 可做。
  const violations = checkFile(
    "noj-core/src/domains/submission/services/foo.ts",
    `import { createObservabilityRouter } from "../../observability/index.ts";\n`,
  );
  assert(
    violations.length > 0,
    "业务域深路径导入观测域 index.ts 应报违规（唯一例外是 admin）",
  );
});

Deno.test("checkFile: admin import observability/index.ts 允许（唯一例外）", () => {
  const violations = checkFile(
    "noj-core/src/domains/admin/routes/observability.ts",
    `import { createObservabilityRouter } from "../../observability/index.ts";\n`,
  );
  assert(
    violations.length === 0,
    `admin 挂载观测管理路由应被允许，实际: ${JSON.stringify(violations)}`,
  );
});

Deno.test("checkFile: 非受限域的 index.ts 仍是公开门面", () => {
  // 只有 observability 的 index.ts 受限；其他域的门面语义不变
  // （catalog → identity/index.ts 等是既有正常用法）。
  const violations = checkFile(
    "noj-core/src/domains/catalog/routes/problems.ts",
    `import { resolveUserId } from "../../identity/index.ts";\n`,
  );
  assert(
    violations.length === 0,
    `其他域 index.ts 应仍可跨域导入，实际: ${JSON.stringify(violations)}`,
  );
});

Deno.test("checkFile: 非相对导入不检查", () => {
  const violations = checkFile(
    "noj-core/src/services/contest/contests.ts",
    `import { Hono } from "hono";\n`,
  );
  assert(violations.length === 0, "非相对导入不应产生违规");
});

Deno.test("checkFile: 业务域 import observability/write.ts 不违规", () => {
  const violations = checkFile(
    "noj-core/src/domains/submission/mq/consumer.ts",
    `import { observability } from "../observability/write.ts";\n`,
  );
  assert(violations.length === 0, "write.ts 应允许");
});

Deno.test("checkFile: 业务域 import observability/services 违规", () => {
  const violations = checkFile(
    "noj-core/src/domains/submission/mq/consumer.ts",
    `import { collectMetricsSnapshot } from "../../observability/services/snapshot.ts";\n`,
  );
  assert(violations.length > 0, "services 深路径应禁止");
});

Deno.test("checkFile: observability 域 import 其他业务域违规", () => {
  const violations = checkFile(
    "noj-core/src/domains/observability/services/snapshot.ts",
    `import { getQueueHealth } from "../../submission/services/queue.ts";\n`,
  );
  assert(violations.length > 0, "观测域不得 import 业务域");
});

Deno.test("domainOf: admin 门面域不参与通用边界检查", () => {
  // admin 是聚合门面，需跨域挂载各子域路由，故有意不在 DOMAINS 集合内。
  assertEquals(domainOf("noj-core/src/domains/admin/index.ts"), null);
});

Deno.test("checkAdminObservabilityReadSide: 真实仓库 admin 不导入观测域读侧", async () => {
  const violations = await checkAdminObservabilityReadSide(".");
  assert(
    violations.length === 0,
    `admin 不应导入观测域读侧，实际: ${JSON.stringify(violations)}`,
  );
});

Deno.test("checkAdminObservabilityReadSide: 用临时夹具验证违规可被检测", async () => {
  const root = await Deno.makeTempDir({ prefix: "noj-admin-boundary-" });
  try {
    const adminDir = `${root}/noj-core/src/domains/admin`;
    await Deno.mkdir(adminDir, { recursive: true });
    // 读侧深路径：应违规
    await Deno.writeTextFile(
      `${adminDir}/bad.ts`,
      `import { collectMetricsSnapshot } from "../observability/services/snapshot.ts";\n`,
    );
    const bad = await checkAdminObservabilityReadSide(root);
    assert(bad.length > 0, "admin 导入观测域读侧应被检测为违规");

    // 写侧门面：应允许
    await Deno.remove(`${adminDir}/bad.ts`);
    await Deno.writeTextFile(
      `${adminDir}/ok.ts`,
      `import { observability } from "../observability/write.ts";\n`,
    );
    const ok = await checkAdminObservabilityReadSide(root);
    assert(
      ok.length === 0,
      `write.ts 门面应允许，实际: ${JSON.stringify(ok)}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
