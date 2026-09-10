/**
 * checkRunbooks 行为测试。
 *
 * 用临时目录构造 fixture，断言真实诊断输出——而非只断言「返回了数组」，
 * 那对任何输入都成立，会让检查器在坏输入下静默通过。
 */

import { checkRunbooks } from "./check-runbooks.ts";
import { resolve } from "node:path";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  实际: ${a}\n  期望: ${e}`);
}

interface Fixture {
  root: string;
  opsAlerts: string;
  sloAlerts: string;
}

/** 建 fixture 目录；两个告警文件内容可分别覆盖。 */
async function makeFixture(
  options: { opsAlerts?: string | null; sloAlerts?: string | null } = {},
): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "noj-runbooks-fixture-" });
  await Deno.mkdir(resolve(root, "deploy/monitoring/runbooks"), {
    recursive: true,
  });
  await Deno.writeTextFile(
    resolve(root, "deploy/monitoring/runbooks/exists.md"),
    "# 存在的 Runbook\n",
  );
  const defaults = {
    opsAlerts: "groups:\n  - name: ops\n    rules: []\n",
    sloAlerts: "groups:\n  - name: slo\n    rules: []\n",
  };
  const contents = { ...defaults, ...options };
  for (
    const [name, body] of [
      ["noj-alerts.yml", contents.opsAlerts],
      ["noj-slo-alerts.yml", contents.sloAlerts],
    ] as const
  ) {
    if (body === null) continue;
    await Deno.writeTextFile(resolve(root, "deploy/monitoring", name), body);
  }
  return {
    root,
    opsAlerts: contents.opsAlerts ?? "",
    sloAlerts: contents.sloAlerts ?? "",
  };
}

async function withFixture(
  options: Parameters<typeof makeFixture>[0],
  fn: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await makeFixture(options);
  try {
    await fn(fixture);
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
}

Deno.test("check-runbooks: 注解指向存在的 runbook 时通过", async () => {
  await withFixture({
    opsAlerts: [
      "groups:",
      "  - name: ops",
      "    rules:",
      "      - alert: A",
      "        annotations:",
      "          runbook: deploy/monitoring/runbooks/exists.md",
      "",
    ].join("\n"),
  }, async ({ root }) => {
    assertEq(await checkRunbooks(root), [], "存在的 runbook 不应报错");
  });
});

Deno.test("check-runbooks: 注解指向缺失 runbook 时报错并含来源文件", async () => {
  await withFixture({
    opsAlerts: [
      "groups:",
      "  - name: ops",
      "    rules:",
      "      - alert: A",
      "        annotations:",
      "          runbook: deploy/monitoring/runbooks/missing.md",
      "",
    ].join("\n"),
  }, async ({ root }) => {
    const errors = await checkRunbooks(root);
    assertEq(errors.length, 1, "应恰好报 1 条错误");
    assert(
      errors[0].includes("deploy/monitoring/runbooks/missing.md"),
      `错误应指出缺失路径，实际: ${errors[0]}`,
    );
    assert(
      errors[0].includes("noj-alerts.yml"),
      `错误应指出来源文件，实际: ${errors[0]}`,
    );
  });
});

Deno.test("check-runbooks: 同一缺失 runbook 被两文件引用时只报一次", async () => {
  const body = [
    "groups:",
    "  - name: g",
    "    rules:",
    "      - alert: A",
    "        annotations:",
    "          runbook: deploy/monitoring/runbooks/missing.md",
    "",
  ].join("\n");
  await withFixture({ opsAlerts: body, sloAlerts: body }, async ({ root }) => {
    const errors = await checkRunbooks(root);
    assertEq(errors.length, 1, "去重后应只报 1 条");
  });
});

Deno.test("check-runbooks: 告警文件缺失时报错", async () => {
  await withFixture({ sloAlerts: null }, async ({ root }) => {
    const errors = await checkRunbooks(root);
    assert(
      errors.some((e) => e.includes("noj-slo-alerts.yml")),
      `应报告缺失的告警文件，实际: ${JSON.stringify(errors)}`,
    );
  });
});

Deno.test("check-runbooks: 零注解时失败而非静默通过", async () => {
  await withFixture({}, async ({ root }) => {
    const errors = await checkRunbooks(root);
    assertEq(errors.length, 1, "零注解必须报错");
    assert(
      errors[0].includes("未发现任何 runbook 注解"),
      `错误应说明零注解，实际: ${errors[0]}`,
    );
  });
});

Deno.test("check-runbooks: 真实仓库当前无死链", async () => {
  assertEq(await checkRunbooks("."), [], "仓库内 runbook 注解应全部可定位");
});
