/**
 * LLM 题目配置与 token 签发测试（纯函数，无需 DB）。
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import { validateBundleManifest } from "../../../catalog/index.ts";
import { isValidLlmConfig } from "../../../catalog/index.ts";
import { buildJudgeTaskLlm } from "../../services/llm-token.ts";
import type { RuntimeConfig } from "../../../catalog/index.ts";
import {
  assertLlmLimitsWithinDefault,
  getDefaultLlmLimits,
  resolveLlmLimits,
} from "../../services/llm-limits.ts";
import { getLlmPlatformDefault } from "../../services/llm.ts";
import { _resetSystemSettingsForTest } from "../../../system/index.ts";

Deno.test("llm-config: isValidLlmConfig", () => {
  assert(isValidLlmConfig({}));
  assert(isValidLlmConfig({ max_calls: 30 }));
  assert(isValidLlmConfig({ max_calls: 30, max_tokens: 20000 }));
  // 存量旧字段容忍并忽略
  assert(isValidLlmConfig({ provider_id: "p1", model: "qwen-plus" }));
  // 非法预算
  assert(!isValidLlmConfig({ max_calls: 0 }));
  assert(!isValidLlmConfig({ max_calls: -1 }));
  assert(!isValidLlmConfig({ max_tokens: 1.5 }));
  assert(!isValidLlmConfig({ max_tokens: "100" }));
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
    llm: { max_calls: 30 },
  });
  assertEquals(manifest.llm?.max_calls, 30);
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
  _resetSystemSettingsForTest();
  const oldToken = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
  const oldUrl = Deno.env.get("NOJ_LLM_GATEWAY_URL");
  Deno.env.set("NOJ_LLM_SERVICE_TOKEN", "test-service-token-0123456789abcdef");
  Deno.env.set("NOJ_LLM_GATEWAY_URL", "http://127.0.0.1:8001");
  Deno.env.set("NOJ_LLM_DEFAULT_PROVIDER_ID", "prov-default");
  Deno.env.set("NOJ_LLM_DEFAULT_MODEL", "qwen-plus");
  const restore = stubProviderFetch(true);
  try {
    const llmTask = await buildJudgeTaskLlm(
      {},
      "sub-1",
      "prob-1",
      "user-1",
      RUNTIME,
    );
    assertEquals(llmTask.provider_id, "prov-default");
    assertEquals(llmTask.allowed_models, ["qwen-plus"]);
    assertEquals(llmTask.gateway_url, "http://127.0.0.1:8001");
    assert(llmTask.eval_token.length > 0);
  } finally {
    restore();
    if (oldToken === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
    else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", oldToken);
    if (oldUrl === undefined) Deno.env.delete("NOJ_LLM_GATEWAY_URL");
    else Deno.env.set("NOJ_LLM_GATEWAY_URL", oldUrl);
    Deno.env.delete("NOJ_LLM_DEFAULT_PROVIDER_ID");
    Deno.env.delete("NOJ_LLM_DEFAULT_MODEL");
    _resetSystemSettingsForTest();
  }
});

Deno.test("llm-config: isValidLlmConfig 接受可选 max 字段", () => {
  assert(isValidLlmConfig({
    provider_id: "p1",
    model: "qwen-plus",
    max_calls: 10,
    max_tokens: 1000,
  }));
  assert(isValidLlmConfig({ provider_id: "p1", model: "qwen-plus" }));
});

Deno.test("llm-config: isValidLlmConfig 拒绝 0/负数/非整数/字符串/null max", () => {
  assert(!isValidLlmConfig({ provider_id: "p1", model: "m", max_calls: 0 }));
  assert(!isValidLlmConfig({ provider_id: "p1", model: "m", max_calls: -1 }));
  assert(!isValidLlmConfig({ provider_id: "p1", model: "m", max_calls: 1.5 }));
  assert(
    !isValidLlmConfig({ provider_id: "p1", model: "m", max_tokens: "100" }),
  );
  assert(
    !isValidLlmConfig({ provider_id: "p1", model: "m", max_tokens: null }),
  );
});

Deno.test("llm-bundle: P 型携带合法 max 字段通过", () => {
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
    llm: {
      provider_id: "p1",
      model: "qwen-plus",
      max_calls: 10,
      max_tokens: 1000,
    },
  });
  assertEquals(manifest.llm?.max_calls, 10);
  assertEquals(manifest.llm?.max_tokens, 1000);
});

Deno.test("llm-bundle: 非法 max 字段被拒", () => {
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
          network: { enabled: true },
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 5000,
          memory_limit_mb: 512,
        },
      },
      llm: { provider_id: "p1", model: "m", max_calls: 0 },
    })
  );
});

Deno.test("llm-limits: getDefaultLlmLimits 读取环境变量", () => {
  const oldCalls = Deno.env.get("NOJ_LLM_MAX_CALLS");
  const oldTokens = Deno.env.get("NOJ_LLM_MAX_TOKENS");
  Deno.env.set("NOJ_LLM_MAX_CALLS", "123");
  Deno.env.set("NOJ_LLM_MAX_TOKENS", "456");
  try {
    assertEquals(getDefaultLlmLimits(), { max_calls: 123, max_tokens: 456 });
  } finally {
    if (oldCalls === undefined) Deno.env.delete("NOJ_LLM_MAX_CALLS");
    else Deno.env.set("NOJ_LLM_MAX_CALLS", oldCalls);
    if (oldTokens === undefined) Deno.env.delete("NOJ_LLM_MAX_TOKENS");
    else Deno.env.set("NOJ_LLM_MAX_TOKENS", oldTokens);
  }
});

Deno.test("llm-limits: resolveLlmLimits 缺省用默认、题目值截断到默认", () => {
  const oldCalls = Deno.env.get("NOJ_LLM_MAX_CALLS");
  const oldTokens = Deno.env.get("NOJ_LLM_MAX_TOKENS");
  Deno.env.set("NOJ_LLM_MAX_CALLS", "100");
  Deno.env.set("NOJ_LLM_MAX_TOKENS", "50000");
  try {
    assertEquals(resolveLlmLimits({}), { max_calls: 100, max_tokens: 50000 });
    assertEquals(
      resolveLlmLimits({ max_calls: 30, max_tokens: 20000 }),
      { max_calls: 30, max_tokens: 20000 },
    );
    assertEquals(
      resolveLlmLimits({ max_calls: 999, max_tokens: 999999 }),
      { max_calls: 100, max_tokens: 50000 },
    );
  } finally {
    if (oldCalls === undefined) Deno.env.delete("NOJ_LLM_MAX_CALLS");
    else Deno.env.set("NOJ_LLM_MAX_CALLS", oldCalls);
    if (oldTokens === undefined) Deno.env.delete("NOJ_LLM_MAX_TOKENS");
    else Deno.env.set("NOJ_LLM_MAX_TOKENS", oldTokens);
  }
});

Deno.test("llm-limits: assertLlmLimitsWithinDefault 超默认抛 BadRequestError", () => {
  const oldCalls = Deno.env.get("NOJ_LLM_MAX_CALLS");
  const oldTokens = Deno.env.get("NOJ_LLM_MAX_TOKENS");
  Deno.env.set("NOJ_LLM_MAX_CALLS", "100");
  Deno.env.set("NOJ_LLM_MAX_TOKENS", "50000");
  try {
    assertLlmLimitsWithinDefault({ max_calls: 30, max_tokens: 20000 });
    assertThrows(
      () => assertLlmLimitsWithinDefault({ max_calls: 101 }),
      BadRequestError,
      "max_calls",
    );
    assertThrows(
      () => assertLlmLimitsWithinDefault({ max_tokens: 50001 }),
      BadRequestError,
      "max_tokens",
    );
  } finally {
    if (oldCalls === undefined) Deno.env.delete("NOJ_LLM_MAX_CALLS");
    else Deno.env.set("NOJ_LLM_MAX_CALLS", oldCalls);
    if (oldTokens === undefined) Deno.env.delete("NOJ_LLM_MAX_TOKENS");
    else Deno.env.set("NOJ_LLM_MAX_TOKENS", oldTokens);
  }
});

Deno.test("llm-limits: 非法环境变量回退默认值", () => {
  const oldCalls = Deno.env.get("NOJ_LLM_MAX_CALLS");
  const oldTokens = Deno.env.get("NOJ_LLM_MAX_TOKENS");
  Deno.env.set("NOJ_LLM_MAX_CALLS", "abc");
  Deno.env.set("NOJ_LLM_MAX_TOKENS", "-1");
  try {
    assertEquals(getDefaultLlmLimits(), { max_calls: 100, max_tokens: 50000 });
  } finally {
    if (oldCalls === undefined) Deno.env.delete("NOJ_LLM_MAX_CALLS");
    else Deno.env.set("NOJ_LLM_MAX_CALLS", oldCalls);
    if (oldTokens === undefined) Deno.env.delete("NOJ_LLM_MAX_TOKENS");
    else Deno.env.set("NOJ_LLM_MAX_TOKENS", oldTokens);
  }
});

Deno.test("llm-limits: resolveLlmLimits 对非正声明值钳制到 1", () => {
  const oldCalls = Deno.env.get("NOJ_LLM_MAX_CALLS");
  const oldTokens = Deno.env.get("NOJ_LLM_MAX_TOKENS");
  Deno.env.set("NOJ_LLM_MAX_CALLS", "100");
  Deno.env.set("NOJ_LLM_MAX_TOKENS", "50000");
  try {
    assertEquals(
      resolveLlmLimits({ max_calls: 0, max_tokens: -10 }),
      { max_calls: 1, max_tokens: 1 },
    );
  } finally {
    if (oldCalls === undefined) Deno.env.delete("NOJ_LLM_MAX_CALLS");
    else Deno.env.set("NOJ_LLM_MAX_CALLS", oldCalls);
    if (oldTokens === undefined) Deno.env.delete("NOJ_LLM_MAX_TOKENS");
    else Deno.env.set("NOJ_LLM_MAX_TOKENS", oldTokens);
  }
});

Deno.test("llm-limits: assertLlmLimitsWithinDefault 拒绝非正整数", () => {
  const oldCalls = Deno.env.get("NOJ_LLM_MAX_CALLS");
  const oldTokens = Deno.env.get("NOJ_LLM_MAX_TOKENS");
  Deno.env.set("NOJ_LLM_MAX_CALLS", "100");
  Deno.env.set("NOJ_LLM_MAX_TOKENS", "50000");
  try {
    assertThrows(
      () => assertLlmLimitsWithinDefault({ max_calls: 0 }),
      BadRequestError,
      "max_calls",
    );
    assertThrows(
      () => assertLlmLimitsWithinDefault({ max_tokens: -1 }),
      BadRequestError,
      "max_tokens",
    );
  } finally {
    if (oldCalls === undefined) Deno.env.delete("NOJ_LLM_MAX_CALLS");
    else Deno.env.set("NOJ_LLM_MAX_CALLS", oldCalls);
    if (oldTokens === undefined) Deno.env.delete("NOJ_LLM_MAX_TOKENS");
    else Deno.env.set("NOJ_LLM_MAX_TOKENS", oldTokens);
  }
});

Deno.test("llm-platform-default: 未配置返回 null", () => {
  _resetSystemSettingsForTest();
  const oldP = Deno.env.get("NOJ_LLM_DEFAULT_PROVIDER_ID");
  const oldM = Deno.env.get("NOJ_LLM_DEFAULT_MODEL");
  Deno.env.delete("NOJ_LLM_DEFAULT_PROVIDER_ID");
  Deno.env.delete("NOJ_LLM_DEFAULT_MODEL");
  try {
    assertEquals(getLlmPlatformDefault(), null);
  } finally {
    if (oldP) Deno.env.set("NOJ_LLM_DEFAULT_PROVIDER_ID", oldP);
    if (oldM) Deno.env.set("NOJ_LLM_DEFAULT_MODEL", oldM);
    _resetSystemSettingsForTest();
  }
});

Deno.test("llm-platform-default: env 兜底生效", () => {
  _resetSystemSettingsForTest();
  Deno.env.set("NOJ_LLM_DEFAULT_PROVIDER_ID", "prov-abc");
  Deno.env.set("NOJ_LLM_DEFAULT_MODEL", "qwen-plus");
  try {
    assertEquals(getLlmPlatformDefault(), {
      provider_id: "prov-abc",
      model: "qwen-plus",
    });
  } finally {
    Deno.env.delete("NOJ_LLM_DEFAULT_PROVIDER_ID");
    Deno.env.delete("NOJ_LLM_DEFAULT_MODEL");
    _resetSystemSettingsForTest();
  }
});

function stubProviderFetch(enabled: boolean): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((_input: Request | URL | string) =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            id: "prov-default",
            name: "stub",
            base_url: "http://stub",
            cost_per_1k_tokens: 0,
            api_key_masked: "sk-****",
            enabled,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const RUNTIME: RuntimeConfig = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 60000,
    memory_limit_mb: 512,
    network: { enabled: true },
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 5000,
    memory_limit_mb: 512,
  },
};

Deno.test("llm-token: 未配置平台默认时抛错", async () => {
  _resetSystemSettingsForTest();
  Deno.env.delete("NOJ_LLM_DEFAULT_PROVIDER_ID");
  Deno.env.delete("NOJ_LLM_DEFAULT_MODEL");
  try {
    await assertRejects(
      () => buildJudgeTaskLlm({}, "sub-1", "prob-1", "user-1", RUNTIME),
      BadRequestError,
    );
  } finally {
    _resetSystemSettingsForTest();
  }
});

Deno.test("llm-token: 使用平台默认填充 provider/model 与预算", async () => {
  _resetSystemSettingsForTest();
  const oldToken = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
  Deno.env.set("NOJ_LLM_SERVICE_TOKEN", "test-service-token-0123456789abcdef");
  Deno.env.set("NOJ_LLM_DEFAULT_PROVIDER_ID", "prov-default");
  Deno.env.set("NOJ_LLM_DEFAULT_MODEL", "qwen-plus");
  const restore = stubProviderFetch(true);
  try {
    const task = await buildJudgeTaskLlm(
      { max_calls: 7 },
      "sub-1",
      "prob-1",
      "user-1",
      RUNTIME,
    );
    assertEquals(task.provider_id, "prov-default");
    assertEquals(task.allowed_models, ["qwen-plus"]);
  } finally {
    restore();
    if (oldToken === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
    else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", oldToken);
    Deno.env.delete("NOJ_LLM_DEFAULT_PROVIDER_ID");
    Deno.env.delete("NOJ_LLM_DEFAULT_MODEL");
    _resetSystemSettingsForTest();
  }
});

Deno.test("llm-token: 默认 Provider 停用时抛错", async () => {
  _resetSystemSettingsForTest();
  const oldToken = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
  Deno.env.set("NOJ_LLM_SERVICE_TOKEN", "test-service-token-0123456789abcdef");
  Deno.env.set("NOJ_LLM_DEFAULT_PROVIDER_ID", "prov-default");
  Deno.env.set("NOJ_LLM_DEFAULT_MODEL", "qwen-plus");
  const restore = stubProviderFetch(false);
  try {
    await assertRejects(
      () => buildJudgeTaskLlm({}, "sub-1", "prob-1", "user-1", RUNTIME),
      BadRequestError,
    );
  } finally {
    restore();
    if (oldToken === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
    else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", oldToken);
    Deno.env.delete("NOJ_LLM_DEFAULT_PROVIDER_ID");
    Deno.env.delete("NOJ_LLM_DEFAULT_MODEL");
    _resetSystemSettingsForTest();
  }
});
