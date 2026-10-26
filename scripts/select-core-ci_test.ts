/** CI 的真实 Python 选择器回归：共享改动覆盖全部任务，教育域不会因缺少环境映射被遗漏。 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { MODULE_TEST_METADATA } from "./module-test-metadata.ts";

async function select(
  aliases: Record<string, string>,
  env: Record<string, string>,
) {
  const command = new Deno.Command("python3", {
    args: [
      "-c",
      `import json, runpy, sys
module = runpy.run_path(sys.argv[1], run_name="selector_test")
data = json.loads(sys.argv[2])
print(json.dumps(module["select_domains"](data["metadata"], data["env"])))`,
      new URL("./select-core-ci.py", import.meta.url).pathname,
      JSON.stringify({ metadata: { legacyDomainToModule: aliases }, env }),
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout)) as string[];
}

Deno.test("Core CI: shared 改动从唯一元数据选择全部域和共享测试", async () => {
  const aliases = MODULE_TEST_METADATA.legacyDomainToModule;
  assertEquals(await select(aliases, { CORE_SHARED: "true" }), [
    ...Object.keys(aliases).sort(),
    "shared",
  ]);
});

Deno.test("Core CI: education 与连字符别名均通过实际选择器触发", async () => {
  assertEquals(
    await select(MODULE_TEST_METADATA.legacyDomainToModule, {
      CORE_EDUCATION: "true",
      CORE_CONTENT_REVIEW: "true",
    }),
    ["content-review", "education"],
  );
});

Deno.test("Core CI: 空元数据必须失败，不能返回零测试假通过", async () => {
  await assertRejects(() => select({}, {}), Error, "拒绝零测试选择");
});

Deno.test("Core CI: workflow 向选择器传递每个元数据域的真实变更标志", async () => {
  const text = await Deno.readTextFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
  );
  assert(text.includes("python3 scripts/select-core-ci.py"));
  for (const domain of Object.keys(MODULE_TEST_METADATA.legacyDomainToModule)) {
    const flag = `CORE_${domain.toUpperCase().replaceAll("-", "_")}`;
    assert(
      text.includes(
        flag + ": " + "${{ steps.filter.outputs.core-" + domain + " }}",
      ),
      `workflow 缺少 ${domain} 对应的 ${flag}，会静默漏测`,
    );
  }
  const start = text.indexOf("\n  core-test-sharded:");
  assert(start >= 0);
  const rest = text.slice(start + 1);
  const nextJob = rest.slice(1).search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
  const job = nextJob < 0 ? rest : rest.slice(0, nextJob + 1);
  assert(
    job.includes("run: deno task test:parallel"),
    "新模块必须执行全部分片",
  );
  assert(!job.includes("--shards 1"), "不得只运行共享分片漏掉业务测试");
});
