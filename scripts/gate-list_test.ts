/**
 * 门禁入口一致性测试（2026-09-21）。
 *
 * 背景：`check-all.ts`（本地）与 `check-ci.ts`（CI）曾各自维护手写清单，长期
 * 分叉——本地少 19 项门禁，造成"本地全绿、CI 红灯"。本测试断言两个入口都从
 * `scripts/gate-list.ts` 的单一事实源派生，并锁住若干关键门禁确实在清单内
 * （防止有人误删）。
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  GATE_SELF_TESTS,
  gateLabel,
  MODULE_CHECKS,
  REPO_GATES,
} from "./gate-list.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/** 清单内是否包含某条命令（按 args 前缀匹配）。 */
function hasGate(args: string[]): boolean {
  return REPO_GATES.some(
    (g) =>
      g.args.length >= args.length &&
      args.every((a, i) => g.args[i] === a) &&
      (args.length === g.args.length || args[args.length - 1] !== undefined),
  );
}

Deno.test("gate-list: 两个入口都从单一事实源派生", async () => {
  for (const file of ["scripts/check-all.ts", "scripts/check-ci.ts"]) {
    const src = await Deno.readTextFile(REPO_ROOT + file);
    assert(
      src.includes('from "./gate-list.ts"'),
      `${file} 必须从 gate-list.ts 导入门禁清单`,
    );
    assert(
      /\bREPO_GATES\b/.test(src),
      `${file} 必须使用 REPO_GATES`,
    );
    // 不得再出现"手写 run([...])"的门禁调用（应全部来自清单）。
    assert(
      !/await run\(\[/.test(src),
      `${file} 不应再手写 run([...]) 清单，门禁必须登记在 gate-list.ts`,
    );
  }
});

Deno.test("gate-list: 本地入口覆盖 CI 入口的全部门禁", async () => {
  const ci = await Deno.readTextFile(REPO_ROOT + "scripts/check-ci.ts");
  const all = await Deno.readTextFile(REPO_ROOT + "scripts/check-all.ts");
  assert(ci.includes("REPO_GATES"), "check-ci 必须使用 REPO_GATES");
  assert(all.includes("REPO_GATES"), "check-all 必须使用 REPO_GATES");
  // check-all 额外包含模块级 check
  assert(all.includes("MODULE_CHECKS"), "check-all 必须包含 MODULE_CHECKS");
  assertEquals(MODULE_CHECKS.length > 0, true);
});

Deno.test("gate-list: 关键门禁不得被删除", () => {
  // 静默跳过棘轮
  assert(
    hasGate(["deno", "run", "-A", "scripts/silent-skip-report.ts", "--check"]),
    "静默跳过棘轮必须在清单内",
  );
  // 迁移安全
  assert(
    hasGate(["deno", "run", "-A", "scripts/check-migration-safety.ts"]),
    "迁移安全门禁必须在清单内",
  );
  // 迁移快照链
  assert(
    hasGate(["deno", "run", "-A", "scripts/check-migration-snapshot-chain.ts"]),
    "迁移快照链门禁必须在清单内",
  );
  // 文件规模棘轮
  assert(
    hasGate(["deno", "run", "-A", "scripts/check-file-size.ts"]),
    "文件规模棘轮必须在清单内",
  );
  // 测试可发现性
  assert(
    hasGate(["deno", "run", "-A", "scripts/check-test-discovery.ts"]),
    "测试可发现性门禁必须在清单内",
  );
  // Deno 版本一致性
  assert(
    hasGate(["deno", "run", "-A", "scripts/check-deno-version.ts"]),
    "Deno 版本门禁必须在清单内",
  );
  // schema parity
  assert(
    REPO_GATES.some(
      (g) =>
        g.cwd === "noj-core" &&
        g.args.includes("scripts/check-schema-parity.ts"),
    ),
    "schema parity 门禁必须在清单内（cwd=noj-core）",
  );
});

Deno.test("gate-list: 全部门禁自测文件都存在", async () => {
  assert(GATE_SELF_TESTS.length > 0);
  for (const file of GATE_SELF_TESTS) {
    try {
      await Deno.stat(REPO_ROOT + file);
    } catch {
      throw new Error(`门禁自测文件不存在：${file}`);
    }
  }
});

Deno.test("gate-list: scripts/*_test.ts 必须全部登记（防假绿）", async () => {
  // 评审发现：`gate-list_test.ts` 与 `coverage-report_test.ts` 曾**不在任何
  // 执行入口内**——写了测试却永不运行，本地与 CI 都显示绿色。
  // 这条自检把"漏登记"变成可发现的失败，而不是靠人记得。
  const registered = new Set(GATE_SELF_TESTS);
  const missing: string[] = [];
  for await (const entry of Deno.readDir(REPO_ROOT + "scripts")) {
    if (!entry.isFile) continue;
    if (!entry.name.endsWith("_test.ts")) continue;
    const rel = `scripts/${entry.name}`;
    if (!registered.has(rel)) missing.push(rel);
  }
  assertEquals(
    missing,
    [],
    `以下门禁自测未登记到 GATE_SELF_TESTS（写了却永不执行）：` +
      missing.join("、"),
  );
});

Deno.test("gate-list: gateLabel 有 label 用 label，否则拼接 args", () => {
  assertEquals(
    gateLabel({ label: "自定义", args: ["deno", "run"] }),
    "自定义",
  );
  assertEquals(
    gateLabel({ args: ["deno", "run", "-A", "x.ts"] }),
    "deno run -A x.ts",
  );
});

Deno.test("gate-list: 清单无重复命令", () => {
  const seen = new Set<string>();
  for (const gate of REPO_GATES) {
    const key = `${gate.cwd ?? "."}::${gate.args.join(" ")}`;
    assert(!seen.has(key), `重复门禁：${key}`);
    seen.add(key);
  }
});
