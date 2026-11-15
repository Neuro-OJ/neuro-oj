/**
 * 题目包 manifest 校验用例表测试。
 *
 * noj-cli 的 `problem lint` / `pack` 直接以相对路径复用 noj-core 的校验实现，
 * 不再维护副本；用例表（同目录 `problem-bundle-manifest.fixture.json`）即唯一行为基线。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  upgradeBundleManifest,
  validateBundleManifest,
} from "../../types/problem-bundle.ts";

interface ContractFixture {
  valid: Array<{ name: string; manifest: Record<string, unknown> }>;
  invalid: Array<{ name: string; manifest: Record<string, unknown> }>;
}

const FIXTURE_URL = new URL(
  "./problem-bundle-manifest.fixture.json",
  import.meta.url,
);

async function loadFixture(): Promise<ContractFixture> {
  return JSON.parse(await Deno.readTextFile(FIXTURE_URL)) as ContractFixture;
}

Deno.test("契约(core): fixture 非空", async () => {
  const fixture = await loadFixture();
  assertEquals(fixture.valid.length > 0, true);
  assertEquals(fixture.invalid.length > 0, true);
});

Deno.test("契约(core): 全部正例必须被接受", async () => {
  const fixture = await loadFixture();
  for (const item of fixture.valid) {
    let err: unknown;
    try {
      validateBundleManifest(item.manifest);
    } catch (e) {
      err = e;
    }
    assertEquals(
      err,
      undefined,
      `正例「${item.name}」被拒绝: ${(err as Error)?.message}`,
    );
  }
});

Deno.test("契约(core): 全部反例必须被拒绝", async () => {
  const fixture = await loadFixture();
  for (const item of fixture.invalid) {
    let err: unknown;
    try {
      validateBundleManifest(item.manifest);
    } catch (e) {
      err = e;
    }
    assertEquals(err !== undefined, true, `反例「${item.name}」未被拒绝`);
  }
});

Deno.test("契约(core): 校验不修改入参", async () => {
  const fixture = await loadFixture();
  for (const item of fixture.valid) {
    const before = JSON.stringify(item.manifest);
    validateBundleManifest(item.manifest);
    assertEquals(JSON.stringify(item.manifest), before);
  }
});

Deno.test("契约: 规范化输出统一为格式 3，无分类、域 ID 或 Provider 选择", async () => {
  const fixture = await loadFixture();
  for (const item of fixture.valid) {
    const result = validateBundleManifest(item.manifest);
    assertEquals(result.format_version, 3);
    assertEquals(["ai", "oi", "objective"].includes(result.kind), true);
    assertEquals(result.is_objective, result.kind === "objective");
    assertEquals(result.judge_type, result.kind === "oi" ? "oi" : "dual");
    assertEquals("type" in result, false);
    assertEquals("domain_id" in result, false);
    if (result.llm) {
      assertEquals(
        Object.keys(result.llm).every((key) =>
          key === "max_calls" || key === "max_tokens" || key === "models"
        ),
        true,
      );
    }
    // 旧格式必须给出升级告警；格式 3 不告警
    assertEquals(
      upgradeBundleManifest(item.manifest).warnings.length > 0,
      item.manifest.format_version !== 3,
    );
  }
});

Deno.test("格式 3: AI 题缺省值补全为官方镜像与平台时限", () => {
  const result = validateBundleManifest(
    {
      format_version: 3,
      kind: "ai",
      title: "x",
      runtime_config: { evaluator: { time_limit_ms: 180000 } },
    },
    { imageBase: "ghcr.io/neuro-oj/" },
  );
  assertEquals(result.runtime_config, {
    evaluator: {
      image: "ghcr.io/neuro-oj/noj-evaluator-python",
      command: "python3 /workspace/evaluate.py",
      time_limit_ms: 180000,
      memory_limit_mb: 512,
    },
    solution: {
      image: "ghcr.io/neuro-oj/noj-solution-python",
      call_timeout_ms: 5000,
      memory_limit_mb: 512,
    },
  });
});

Deno.test("格式 3: 声明 llm 隐含开启 evaluator 网络；prediction 不补 solution", () => {
  const llm = validateBundleManifest({
    format_version: 3,
    kind: "ai",
    title: "x",
    llm: { max_calls: 3 },
  });
  assertEquals(
    (llm.runtime_config as { evaluator: { network?: unknown } }).evaluator
      .network,
    { enabled: true },
  );
  const prediction = validateBundleManifest({
    format_version: 3,
    kind: "ai",
    title: "x",
    submission_mode: "prediction",
  });
  assertEquals("solution" in (prediction.runtime_config ?? {}), false);
});

Deno.test("格式 3: 不支持字段的错误信息列出该题型可用字段", () => {
  let message = "";
  try {
    validateBundleManifest({
      format_version: 3,
      kind: "objective",
      title: "x",
      template: "t.py",
    });
  } catch (err) {
    message = (err as Error).message;
  }
  assertEquals(message.includes("kind=objective 不支持字段 template"), true);
  assertEquals(message.includes("samples"), true);
});

Deno.test("格式 2 → 3：判别字段转换为 kind 且丢弃未知字段", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ format_version: 2, title: "x", is_objective: true }, "objective"],
    [{ format_version: 2, title: "x", judge_type: "oi" }, "oi"],
    [{ format_version: 2, title: "x", judge_type: "dual" }, "ai"],
    [{ format_version: 1, type: "P", title: "x" }, "ai"],
  ];
  for (const [raw, kind] of cases) {
    const { manifest } = upgradeBundleManifest(raw);
    assertEquals(manifest.kind, kind);
    assertEquals("is_objective" in manifest, false);
    assertEquals("judge_type" in manifest, false);
    assertEquals("type" in manifest, false);
  }
  const { manifest, warnings } = upgradeBundleManifest({
    format_version: 2,
    title: "x",
    categories: ["a"],
  });
  assertEquals("categories" in manifest, false);
  assertEquals(warnings.some((w) => w.includes("categories")), true);
});
