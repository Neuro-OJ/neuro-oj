import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  domainLlmSettings,
  roles,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  createDomain,
  ensureDefaultWorkspace,
  transferDomain,
} from "../../../workspace/index.ts";
import { _resetSystemSettingsForTest } from "../../../system/index.ts";
import {
  buildJudgeTaskLlm,
  getDomainLlmDefault,
  listInstanceLlmQuotas,
  listLlmQuotas,
  readDomainLlmProviders,
  readDomainLlmSettings,
  saveDomainLlmSettings,
} from "../../index.ts";
import type { RuntimeConfig } from "../../../catalog/index.ts";
import { decodeBase64 } from "@std/encoding/base64";

await resetDbForTest();
async function account(admin = false) {
  const id = crypto.randomUUID(), now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: id,
    email: id + "@test.invalid",
    created_at: now,
    updated_at: now,
  });
  if (admin) {
    const [role] = await getDb().select().from(roles).where(
      eq(roles.name, "admin"),
    );
    await getDb().insert(userRoles).values({ user_id: id, role_id: role.id });
  }
  return id;
}
const runtime: RuntimeConfig = {
  evaluator: {
    image: "noj-evaluator-python",
    time_limit_ms: 1000,
    memory_limit_mb: 128,
    network: { enabled: true },
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 1000,
    memory_limit_mb: 128,
  },
};
async function decodeToken(token: string, secret: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const bytes = decodeBase64(token);
  const result = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(result));
}

Deno.test({
  name: "域 LLM：新域无主域默认回退、配置revision冲突、旧冻结选择不能跨域",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await resetDbForTest();
    const actor = await account(true);
    await ensureDefaultWorkspace();
    const school = await createDomain({
      slug: "llm-school",
      name: "学校",
      preset: "education",
    }, actor);
    const originalFetch = globalThis.fetch;
    const originalSecret = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
    Deno.env.set(
      "NOJ_LLM_SERVICE_TOKEN",
      "domain-test-secret-0123456789abcdef",
    );
    let calls = 0;
    globalThis.fetch = () => {
      calls++;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              id: "school-provider",
              domain_id: school.id,
              enabled: true,
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    };
    try {
      assertEquals(await getDomainLlmDefault(school.id), null);
      const empty = await readDomainLlmSettings(school.slug, actor);
      assertEquals(empty.revision, 0);
      await assertRejects(
        () =>
          buildJudgeTaskLlm({}, "sub", "public-source", actor, runtime, {
            domainId: school.id,
            attemptId: "new",
          }),
        BadRequestError,
      );
      assertEquals(calls, 0);
      const saved = await saveDomainLlmSettings(school.slug, actor, 0, {
        provider_id: "school-provider",
        model: "school-model",
      });
      assertEquals(saved.revision, 1);
      await assertRejects(
        () =>
          saveDomainLlmSettings(school.slug, actor, 0, {
            provider_id: null,
            model: null,
          }),
        ConflictError,
      );
      const task = await buildJudgeTaskLlm(
        { max_calls: 7, max_tokens: 123 },
        "sub",
        "public-source",
        actor,
        runtime,
        {
          domainId: school.id,
          attemptId: "new",
          problemVersionId: "version",
        },
      );
      const token = await decodeToken(
        task.eval_token,
        Deno.env.get("NOJ_LLM_SERVICE_TOKEN")!,
      );
      assertEquals(token.domain_id, school.id);
      assertEquals(token.protocol_version, 3);
      assertEquals(token.provider_id, "school-provider");
      assertEquals(token.allowed_models, ["school-model"]);
      assertEquals(token.max_calls, 7);
      await saveDomainLlmSettings(school.slug, actor, 1, {
        provider_id: "school-provider",
        model: "changed-model",
      });
      const frozenTask = await buildJudgeTaskLlm(
        {},
        "sub",
        "public-source",
        actor,
        runtime,
        {
          domainId: school.id,
          attemptId: "new",
          frozen: {
            domain_id: school.id,
            provider_id: "school-provider",
            model: "school-model",
            max_calls: 7,
            max_tokens: 123,
          },
        },
      );
      assertEquals(frozenTask.allowed_models, ["school-model"]);
      await assertRejects(
        () =>
          buildJudgeTaskLlm({}, "sub", "public-source", actor, runtime, {
            domainId: school.id,
            attemptId: "new",
            frozen: {
              provider_id: "school-provider",
              model: "legacy",
              max_calls: 7,
              max_tokens: 123,
            },
          }),
        BadRequestError,
      );
      await saveDomainLlmSettings(school.slug, actor, 2, {
        provider_id: null,
        model: null,
      });
      assertEquals(await getDomainLlmDefault(school.id), null);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSecret === undefined) {
        Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
      } else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", originalSecret);
      _resetSystemSettingsForTest();
    }
  },
});

Deno.test({
  name: "域 LLM：实例配额列表显式标记，域配额请求不携带实例标记",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const previousFetch = globalThis.fetch;
    const previousToken = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
    Deno.env.set(
      "NOJ_LLM_SERVICE_TOKEN",
      "domain-test-secret-0123456789abcdef",
    );
    const captured: Headers[] = [];
    globalThis.fetch = (_input, init) => {
      captured.push(new Headers(init?.headers));
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    try {
      assertEquals(await listInstanceLlmQuotas(), []);
      assertEquals(await listLlmQuotas("school-a"), []);
      assertEquals(captured[0].get("X-Noj-Instance-Quota"), "1");
      assertEquals(captured[1].get("X-Noj-Instance-Quota"), null);
      assertEquals(captured[1].get("X-Noj-Domain-Id"), "school-a");
    } finally {
      globalThis.fetch = previousFetch;
      if (previousToken === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
      else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", previousToken);
    }
  },
});

Deno.test({
  name: "域 LLM：A域负责人无法读取B域Provider，授权检查先于Gateway调用",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await resetDbForTest();
    const actor = await account(true), owner = await account();
    const a = await createDomain(
      { slug: "llm-a", name: "A", preset: "team" },
      actor,
    );
    const b = await createDomain(
      { slug: "llm-b", name: "B", preset: "team" },
      actor,
    );
    // 转交前需要有效域成员；直接写入当前成员夹具由公开加入入口创建。
    const { createDomainInvitation, consumeDomainInvitation } = await import(
      "../../../workspace/index.ts"
    );
    const invite = await createDomainInvitation(
      a.slug,
      actor,
      owner + "@test.invalid",
    );
    await consumeDomainInvitation(invite.token, owner);
    await transferDomain(a.slug, actor, owner);
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => {
      calls++;
      return Promise.resolve(new Response("{}"));
    };
    try {
      await assertRejects(
        () => readDomainLlmProviders(b.slug, owner),
        NotFoundError,
      );
      assertEquals(calls, 0);
      const [settings] = await getDb().select().from(domainLlmSettings).where(
        eq(domainLlmSettings.domain_id, b.id),
      );
      assertEquals(settings, undefined);
    } finally {
      globalThis.fetch = original;
    }
  },
});
