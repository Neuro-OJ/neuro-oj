import { checkFile, domainOf, resolveRelativeImport } from "./check-domains.ts";

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

Deno.test("checkFile: 业务域 import observability 读侧 deep path 违规", () => {
  const violations = checkFile(
    "noj-core/src/domains/submission/mq/consumer.ts",
    `import { collectMetricsSnapshot } from "../../observability/services/snapshot.ts";\n`,
  );
  assert(
    violations.length > 0,
    "业务域不得 import 观测域读侧深路径",
  );
});

Deno.test("checkFile: 业务域 import observability/write.ts 允许", () => {
  const violations = checkFile(
    "noj-core/src/domains/submission/mq/consumer.ts",
    `import { observability } from "../../observability/write.ts";\n`,
  );
  assert(violations.length === 0, "写侧门面应允许");
});

Deno.test("domainOf: admin 门面域不参与边界检查", () => {
  // admin 是聚合门面，需跨域挂载各子域路由，故有意不在 DOMAINS 集合内。
  assertEquals(domainOf("noj-core/src/domains/admin/index.ts"), null);
});
