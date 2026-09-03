/**
 * LLM 题目配置与 token 签发测试（纯函数，无需 DB）。
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { validateBundleManifest } from "./../../src/domains/catalog/types/problem-bundle.ts";
import { isValidLlmConfig } from "./../../src/domains/catalog/types/problems.ts";
import { buildJudgeTaskLlm } from "./../../src/domains/gateway/services/llm-token.ts";
import type { RuntimeConfig } from "../../src/domains/catalog/index.ts";

Deno.test("llm-config: isValidLlmConfig", () => {
  assert(isValidLlmConfig({ provider_id: "p1", model: "qwen-plus" }));
  assert(!isValidLlmConfig({ provider_id: "", model: "qwen-plus" }));
  assert(!isValidLlmConfig({ provider_id: "p1" }));
  assert(!isValidLlmConfig(null));
});

Deno.test("llm-bundle: P 型 + 网络开启通过", () => {
  const manifest = validateBundleManifest({
    format_version: 1,
    title: "LLM 题",
    type: "P",
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
        time_limit_ms: 60000,
        memory_limit_mb: 512,
        network: { enabled: true },
      },
      solution: {
        image: "noj-solution-python",
        call_timeout_ms: 5000,
        memory_limit_mb: 512,
      },
    },
    llm: { provider_id: "p1", model: "qwen-plus" },
  });
  assertEquals(manifest.llm?.model, "qwen-plus");
});

Deno.test("llm-bundle: U 型携带 llm 被拒", () => {
  assertThrows(() =>
    validateBundleManifest({
      format_version: 1,
      title: "LLM 题",
      type: "U",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          time_limit_ms: 60000,
          memory_limit_mb: 512,
          network: { enabled: true },
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 5000,
          memory_limit_mb: 512,
        },
      },
      llm: { provider_id: "p1", model: "qwen-plus" },
    })
  );
});

Deno.test("llm-bundle: 未开启网络被拒", () => {
  assertThrows(() =>
    validateBundleManifest({
      format_version: 1,
      title: "LLM 题",
      type: "P",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          time_limit_ms: 60000,
          memory_limit_mb: 512,
          network: { enabled: false },
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 5000,
          memory_limit_mb: 512,
        },
      },
      llm: { provider_id: "p1", model: "qwen-plus" },
    })
  );
});

Deno.test("llm-token: buildJudgeTaskLlm 生成可校验字段", async () => {
  const oldToken = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
  const oldUrl = Deno.env.get("NOJ_LLM_GATEWAY_URL");
  Deno.env.set("NOJ_LLM_SERVICE_TOKEN", "test-service-token-0123456789abcdef");
  Deno.env.set("NOJ_LLM_GATEWAY_URL", "http://127.0.0.1:8001");
  try {
    const runtime: RuntimeConfig = {
      evaluator: {
        image: "noj-evaluator-python",
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 30000,
        memory_limit_mb: 256,
      },
      solution: {
        image: "noj-solution-python",
        call_timeout_ms: 5000,
        memory_limit_mb: 256,
      },
    };
    const llmTask = await buildJudgeTaskLlm(
      { provider_id: "p1", model: "qwen-plus" },
      "sub-1",
      "prob-1",
      "user-1",
      runtime,
    );
    assertEquals(llmTask.provider_id, "p1");
    assertEquals(llmTask.allowed_models, ["qwen-plus"]);
    assertEquals(llmTask.gateway_url, "http://127.0.0.1:8001");
    assert(llmTask.eval_token.length > 0);
  } finally {
    if (oldToken === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
    else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", oldToken);
    if (oldUrl === undefined) Deno.env.delete("NOJ_LLM_GATEWAY_URL");
    else Deno.env.set("NOJ_LLM_GATEWAY_URL", oldUrl);
  }
});
