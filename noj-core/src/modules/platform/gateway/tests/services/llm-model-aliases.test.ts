/**
 * LLM 模型别名：别名管理、解析与 eval_token 签发（独立测试数据库）。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { decodeBase64 } from "@std/encoding/base64";
import { ROOT_USER_ID } from "../../../../../shared/base/constants.ts";
import { BadRequestError } from "../../../../../shared/base/errors.ts";
import { getDb } from "../../../../../shared/db/connection.ts";
import {
  domainLlmSettings,
  llmModelAliases,
} from "../../../../../shared/db/schema.ts";
import {
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
} from "../../../../access/workspace/index.ts";
import { isValidLlmConfig } from "../../../../problems/index.ts";
import type { RuntimeConfig } from "../../../../problems/index.ts";
import { _resetSystemSettingsForTest } from "../../../system/index.ts";
import {
  assertLlmModelsValid,
  deleteLlmModelAlias,
  isDefaultOnly,
  listLlmModelAliases,
  normalizeLlmModels,
  resolveLlmModels,
  upsertLlmModelAlias,
} from "../../services/llm-model-aliases.ts";
import { buildJudgeTaskLlm } from "../../services/llm-token.ts";

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

const ACTOR = ROOT_USER_ID;
const TOKEN_SECRET = "test-service-token-0123456789abcdef";

/** 以 gateway 同样的方式解密 eval_token，验证签发内容。 */
async function openToken(token: string): Promise<Record<string, unknown>> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(TOKEN_SECRET),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const data = decodeBase64(token);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: data.slice(0, 12) },
    key,
    data.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/** 桩 gateway：任何 Provider ID 都存在且启用，disabledIds 中的返回 enabled=false。 */
function stubGateway(disabledIds: string[] = []): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    await Promise.resolve();
    const url = new URL(String(input));
    if (url.pathname.endsWith("/internal/execution-config")) {
      const raw = typeof init?.body === "string"
        ? JSON.parse(init.body) as { aliases?: string[] }
        : { aliases: [] };
      const aliases = raw.aliases ?? [];
      const providerId = aliases.includes("other") ? "prov-b" : "prov-a";
      const modelByAlias: Record<string, string> = {
        default: "qwen-plus",
        fast: "m-fast",
        big: "m-big",
        other: "m-o",
      };
      return new Response(
        JSON.stringify({
          data: {
            provider_id: providerId,
            models: aliases.map((alias) => ({
              alias,
              model: modelByAlias[alias] ?? alias,
            })),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            domain_id: DEFAULT_DOMAIN_ID,
            revision: 1,
            id,
            name: "stub",
            base_url: "http://stub",
            cost_per_1k_tokens: 0,
            api_key_masked: "sk-****",
            enabled: !disabledIds.includes(id),
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function withEnv(fn: () => Promise<void>): Promise<void> {
  _resetSystemSettingsForTest();
  Deno.env.set("NOJ_LLM_SERVICE_TOKEN", TOKEN_SECRET);
  Deno.env.set("NOJ_LLM_GATEWAY_URL", "http://127.0.0.1:8001");
  Deno.env.set("NOJ_LLM_DEFAULT_PROVIDER_ID", "prov-a");
  Deno.env.set("NOJ_LLM_DEFAULT_MODEL", "qwen-plus");
  await getDb().delete(llmModelAliases);
  await ensureDefaultWorkspace();
  await getDb().insert(domainLlmSettings).values({
    domain_id: DEFAULT_DOMAIN_ID,
    provider_id: "prov-a",
    model: "qwen-plus",
    revision: 1,
    updated_at: new Date().toISOString(),
  })
    .onConflictDoUpdate({
      target: domainLlmSettings.domain_id,
      set: { provider_id: "prov-a", model: "qwen-plus" },
    });
  try {
    await fn();
  } finally {
    await getDb().delete(llmModelAliases);
    for (
      const k of [
        "NOJ_LLM_SERVICE_TOKEN",
        "NOJ_LLM_GATEWAY_URL",
        "NOJ_LLM_DEFAULT_PROVIDER_ID",
        "NOJ_LLM_DEFAULT_MODEL",
      ]
    ) Deno.env.delete(k);
    _resetSystemSettingsForTest();
  }
}

Deno.test("llm-alias: isValidLlmConfig 校验 models 格式", () => {
  assert(isValidLlmConfig({}));
  assert(isValidLlmConfig({ models: ["default"] }));
  assert(isValidLlmConfig({ models: ["fast", "reasoning_2", "a-b"] }));
  assert(!isValidLlmConfig({ models: [] }));
  assert(!isValidLlmConfig({ models: ["Fast"] }));
  assert(!isValidLlmConfig({ models: ["1fast"] }));
  assert(!isValidLlmConfig({ models: ["fast", "fast"] }));
  assert(!isValidLlmConfig({ models: "fast" }));
  assert(!isValidLlmConfig({ models: ["a".repeat(33)] }));
  assert(
    !isValidLlmConfig({ models: Array.from({ length: 9 }, (_, i) => `m${i}`) }),
  );
});

Deno.test("llm-alias: normalize / isDefaultOnly", () => {
  assertEquals(normalizeLlmModels({}), ["default"]);
  assertEquals(normalizeLlmModels(null), ["default"]);
  assertEquals(normalizeLlmModels({ models: ["fast"] }), ["fast"]);
  assert(isDefaultOnly([{ alias: "default" }]));
  assert(!isDefaultOnly([{ alias: "default" }, { alias: "fast" }]));
  assert(!isDefaultOnly([{ alias: "fast" }]));
});

Deno.test("llm-alias: upsert 校验保留名与格式，并可更新、列出、删除", async () => {
  await withEnv(async () => {
    const restore = stubGateway();
    try {
      await assertRejects(
        () =>
          upsertLlmModelAlias(
            "default",
            { provider_id: "prov-a", model: "m" },
            ACTOR,
          ),
        BadRequestError,
        "保留别名",
      );
      await assertRejects(
        () =>
          upsertLlmModelAlias(
            "Bad Name",
            { provider_id: "prov-a", model: "m" },
            ACTOR,
          ),
        BadRequestError,
      );
      await assertRejects(
        () =>
          upsertLlmModelAlias(
            "fast",
            { provider_id: "prov-a", model: "" },
            ACTOR,
          ),
        BadRequestError,
      );
      await upsertLlmModelAlias(
        "fast",
        { provider_id: "prov-a", model: "Qwen/Qwen3-8B", description: "快" },
        ACTOR,
      );
      const updated = await upsertLlmModelAlias(
        "fast",
        { provider_id: "prov-a", model: "Qwen/Qwen3-14B" },
        ACTOR,
        DEFAULT_DOMAIN_ID,
        1,
      );
      assertEquals(updated.model, "Qwen/Qwen3-14B");
      assertEquals((await listLlmModelAliases()).length, 1);
      assertEquals(
        await deleteLlmModelAlias("fast", DEFAULT_DOMAIN_ID, updated.revision),
        true,
      );
      assertEquals(
        await deleteLlmModelAlias("fast", DEFAULT_DOMAIN_ID, updated.revision),
        false,
      );
    } finally {
      restore();
    }
  });
});

Deno.test("llm-alias: resolve 多别名同 Provider；未配置 / 跨 Provider 报 400", async () => {
  await withEnv(async () => {
    const restore = stubGateway();
    try {
      await upsertLlmModelAlias("fast", {
        provider_id: "prov-a",
        model: "m-fast",
      }, ACTOR);
      await upsertLlmModelAlias("big", {
        provider_id: "prov-a",
        model: "m-big",
      }, ACTOR);
      await upsertLlmModelAlias("other", {
        provider_id: "prov-b",
        model: "m-o",
      }, ACTOR);

      const ok = await resolveLlmModels(["default", "fast", "big"]);
      assertEquals(ok.provider_id, "prov-a");
      assertEquals(ok.models, [
        { alias: "default", model: "qwen-plus" },
        { alias: "fast", model: "m-fast" },
        { alias: "big", model: "m-big" },
      ]);

      await assertRejects(
        () => resolveLlmModels(["ghost"]),
        BadRequestError,
        "ghost",
      );
      await assertRejects(
        () => resolveLlmModels(["fast", "other"]),
        BadRequestError,
        "不同 Provider",
      );
      // default 指向 prov-a，other 在 prov-b
      await assertRejects(
        () => resolveLlmModels(["default", "other"]),
        BadRequestError,
        "不同 Provider",
      );
    } finally {
      restore();
    }
  });
});

Deno.test("llm-alias: 发布只声明模型能力，导入提示缺配置，受理才验证 Provider 组合", async () => {
  await withEnv(async () => {
    const restore = stubGateway();
    try {
      await upsertLlmModelAlias("fast", {
        provider_id: "prov-a",
        model: "m-fast",
      }, ACTOR);
      await upsertLlmModelAlias("other", {
        provider_id: "prov-b",
        model: "m-o",
      }, ACTOR);

      assertEquals(await assertLlmModelsValid({}), []);
      assertEquals(await assertLlmModelsValid({ models: ["ghost"] }), []);
      // 宽松：未定义别名只警告
      const warnings = await assertLlmModelsValid(
        { models: ["ghost", "fast"] },
        { allowUnknown: true },
      );
      assertEquals(warnings.length, 1);
      assert(warnings[0].includes("ghost"));
      // 题目声明不绑定部署 Provider；新受理仍拒绝跨 Provider 的模型集合。
      assertEquals(
        await assertLlmModelsValid({ models: ["fast", "other"] }, {
          allowUnknown: true,
        }),
        [],
      );
      await assertRejects(
        () => resolveLlmModels(["fast", "other"]),
        BadRequestError,
        "不同 Provider",
      );
    } finally {
      restore();
    }
  });
});

Deno.test("llm-alias: token——default-only 保持旧形态，别名题携带 model_map", async () => {
  await withEnv(async () => {
    const restore = stubGateway();
    try {
      await upsertLlmModelAlias("fast", {
        provider_id: "prov-a",
        model: "m-fast",
      }, ACTOR);
      const scope = { attemptId: "att-1", problemVersionId: "ver-1" };

      const legacy = await buildJudgeTaskLlm({}, "s", "p", "u", RUNTIME, scope);
      assertEquals(legacy.allowed_models, ["qwen-plus"]);
      assertEquals(legacy.model_map, undefined);
      const legacyPayload = await openToken(legacy.eval_token);
      assertEquals(legacyPayload.allowed_models, ["qwen-plus"]);
      assert(!("model_map" in legacyPayload));

      const aliased = await buildJudgeTaskLlm(
        { models: ["default", "fast"] },
        "s",
        "p",
        ACTOR,
        RUNTIME,
        scope,
      );
      assertEquals(aliased.allowed_models, ["default", "fast"]);
      assertEquals(aliased.model_map, { default: "qwen-plus", fast: "m-fast" });
      const payload = await openToken(aliased.eval_token);
      assertEquals(payload.allowed_models, ["default", "fast"]);
      assertEquals(payload.model_map, { default: "qwen-plus", fast: "m-fast" });
      assertEquals(payload.provider_id, "prov-a");
    } finally {
      restore();
    }
  });
});

Deno.test("llm-alias: 冻结快照——别名事后改映射不影响重派；旧快照按 default 读取", async () => {
  await withEnv(async () => {
    const restore = stubGateway();
    try {
      await upsertLlmModelAlias("fast", {
        provider_id: "prov-a",
        model: "m-fast",
      }, ACTOR);
      // 管理员事后把 fast 改指向另一个模型
      await upsertLlmModelAlias(
        "fast",
        {
          provider_id: "prov-a",
          model: "m-NEW",
        },
        ACTOR,
        DEFAULT_DOMAIN_ID,
        1,
      );
      const frozen = await buildJudgeTaskLlm(
        { models: ["fast"] },
        "s",
        "p",
        ACTOR,
        RUNTIME,
        {
          attemptId: "att-2",
          frozen: {
            domain_id: DEFAULT_DOMAIN_ID,
            provider_id: "prov-a",
            model: "m-fast",
            max_calls: 5,
            max_tokens: 500,
            models: [{ alias: "fast", model: "m-fast" }],
          },
        },
      );
      assertEquals(frozen.model_map, { fast: "m-fast" });

      // 旧快照无 models 字段：按单个 default 处理（allowed_models 为真实模型名）
      const legacy = await buildJudgeTaskLlm({}, "s", "p", "u", RUNTIME, {
        attemptId: "att-3",
        frozen: {
          domain_id: DEFAULT_DOMAIN_ID,
          provider_id: "prov-a",
          model: "old-model",
          max_calls: 5,
          max_tokens: 500,
        },
      });
      assertEquals(legacy.allowed_models, ["old-model"]);
      assertEquals(legacy.model_map, undefined);
    } finally {
      restore();
    }
  });
});

Deno.test("llm-alias: 别名所属 Provider 停用时提交报 400", async () => {
  await withEnv(async () => {
    const restore = stubGateway(["prov-b"]);
    try {
      await upsertLlmModelAlias("other", {
        provider_id: "prov-b",
        model: "m-o",
      }, ACTOR);
      const err = await assertRejects(
        () =>
          buildJudgeTaskLlm({ models: ["other"] }, "s", "p", "u", RUNTIME, {
            attemptId: "att-4",
          }),
        BadRequestError,
      );
      assert(err.message.includes("Provider"));
    } finally {
      restore();
    }
  });
});
