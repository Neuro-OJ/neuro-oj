/**
 * checkRuntimeContract 行为测试。
 *
 * 断言真实诊断输出，而非只断言「返回了数组」。
 */

import { checkRuntimeContract } from "./check-runtime-contract.ts";
import { resolve } from "node:path";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function withTempRoot(
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "noj-runtime-contract-" });
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("check-runtime-contract: prometheus.yml 缺失时返回错误而非抛出", async () => {
  await withTempRoot(async (root) => {
    const errors = await checkRuntimeContract(root);
    assert(errors.length > 0, "缺失 prometheus.yml 应产生错误");
    assert(
      errors.some((e) => e.includes("prometheus.yml")),
      `应指出 prometheus.yml，实际: ${JSON.stringify(errors)}`,
    );
  });
});

Deno.test("check-runtime-contract: 空 prometheus.yml 报缺失 job", async () => {
  await withTempRoot(async (root) => {
    await Deno.mkdir(resolve(root, "deploy/monitoring"), { recursive: true });
    await Deno.writeTextFile(
      resolve(root, "deploy/monitoring/prometheus.yml"),
      "global: {}\n",
    );
    const errors = await checkRuntimeContract(root);
    assert(
      errors.some((e) => e.includes("缺少 job")),
      `应报告缺失的 job，实际: ${JSON.stringify(errors)}`,
    );
  });
});

Deno.test("check-runtime-contract: 真实仓库契约成立", async () => {
  const errors = await checkRuntimeContract(".");
  assert(
    errors.length === 0,
    `仓库契约应无错误，实际: ${JSON.stringify(errors)}`,
  );
});
