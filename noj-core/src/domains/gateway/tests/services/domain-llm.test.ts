import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  domainLlmSettings,
  roles,
  systemSettings,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  createDomain,
  DEFAULT_DOMAIN_ID,
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
  readDomainLlmUsage,
  saveDomainLlmQuota,
  saveDomainLlmSettings,
} from "../../index.ts";
import type { RuntimeConfig } from "../../../../modules/problems/index.ts";
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
    command: "python3 evaluate.py",
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
              domain_id: DEFAULT_DOMAIN_ID,
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
  name: "域 LLM：读取主域默认只读，不因平台 env 兜底隐式写入配置",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await resetDbForTest();
    const oldProvider = Deno.env.get("NOJ_LLM_DEFAULT_PROVIDER_ID");
    const oldModel = Deno.env.get("NOJ_LLM_DEFAULT_MODEL");
    Deno.env.set("NOJ_LLM_DEFAULT_PROVIDER_ID", "explicit-provider");
    Deno.env.set("NOJ_LLM_DEFAULT_MODEL", "explicit-model");
    _resetSystemSettingsForTest();
    try {
      await ensureDefaultWorkspace();
      const before = await getDb().select({
        domain_id: domainLlmSettings.domain_id,
      })
        .from(domainLlmSettings)
        .where(eq(domainLlmSettings.domain_id, DEFAULT_DOMAIN_ID));
      assertEquals(before, []);
      assertEquals(await getDomainLlmDefault(DEFAULT_DOMAIN_ID), null);
      const after = await getDb().select({
        domain_id: domainLlmSettings.domain_id,
      })
        .from(domainLlmSettings)
        .where(eq(domainLlmSettings.domain_id, DEFAULT_DOMAIN_ID));
      assertEquals(after, []);
    } finally {
      if (oldProvider === undefined) {
        Deno.env.delete("NOJ_LLM_DEFAULT_PROVIDER_ID");
      } else Deno.env.set("NOJ_LLM_DEFAULT_PROVIDER_ID", oldProvider);
      if (oldModel === undefined) Deno.env.delete("NOJ_LLM_DEFAULT_MODEL");
      else Deno.env.set("NOJ_LLM_DEFAULT_MODEL", oldModel);
      _resetSystemSettingsForTest();
    }
  },
});

Deno.test({
  name:
    "域 LLM：真实域负责人只能降低总额度，换ID和null不能绕过，平台可治理提高",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await resetDbForTest();
    const admin = await account(true), owner = await account();
    const school = await createDomain({
      slug: "llm-lower-only",
      name: "额度班",
      preset: "education",
    }, admin);
    const { createDomainInvitation, consumeDomainInvitation } = await import(
      "../../../workspace/index.ts"
    );
    const invite = await createDomainInvitation(
      school.slug,
      admin,
      owner + "@test.invalid",
    );
    await consumeDomainInvitation(invite.token, owner);
    await transferDomain(school.slug, admin, owner);
    const caps = {
      day: { max_calls: 100, max_tokens: null, max_cost: null },
      month: { max_calls: null, max_tokens: null, max_cost: null },
    };
    await getDb().insert(systemSettings).values({
      key: "domain_llm_quota_caps",
      value: JSON.stringify(JSON.stringify(caps)),
      updated_at: new Date().toISOString(),
    })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: JSON.stringify(JSON.stringify(caps)) },
      });
    const current = [
      {
        id: "current",
        scope_type: "domain",
        scope_id: "",
        window_type: "day",
        max_calls: 50,
        max_tokens: null,
        max_cost: null,
      },
      {
        id: "loose-history",
        scope_type: "domain",
        scope_id: "",
        window_type: "day",
        max_calls: 90,
        max_tokens: null,
        max_cost: null,
      },
      {
        id: "month",
        scope_type: "domain",
        scope_id: "",
        window_type: "month",
        max_calls: 5,
        max_tokens: null,
        max_cost: null,
      },
      {
        id: "user",
        scope_type: "user",
        scope_id: owner,
        window_type: "day",
        max_calls: 10,
        max_tokens: null,
        max_cost: null,
      },
    ];
    const original = globalThis.fetch,
      token = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
    Deno.env.set(
      "NOJ_LLM_SERVICE_TOKEN",
      "domain-test-secret-0123456789abcdef",
    );
    let writes = 0;
    globalThis.fetch = (_input, init) => {
      assertEquals(
        new Headers(init?.headers).get("X-Noj-Domain-Id"),
        school.id,
      );
      if (!init?.method || init.method === "GET") {
        return Promise.resolve(
          new Response(JSON.stringify({ data: current }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }
      writes++;
      const body = JSON.parse(String(init.body)),
        row = current.find((entry) => entry.id === body.id);
      if (row) Object.assign(row, body);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              id: body.id,
              revision: Number(new Headers(init?.headers).get("If-Match")) + 1,
            },
          }),
          {
            headers: { "content-type": "application/json" },
          },
        ),
      );
    };
    const total = (id: string, max_calls: number | null) => ({
      id,
      scope_type: "domain" as const,
      scope_id: "",
      window_type: "day" as const,
      max_calls,
      max_tokens: null,
      max_cost: null,
    });
    try {
      await assertRejects(
        () => saveDomainLlmQuota(school.slug, owner, total("current", 80), 1),
        ForbiddenError,
      );
      assertEquals(writes, 0);
      assertEquals(
        await saveDomainLlmQuota(school.slug, owner, total("current", 40), 1),
        { id: "current", revision: 2 },
      );
      await assertRejects(
        () => saveDomainLlmQuota(school.slug, owner, total("new-id", 80), 1),
        ForbiddenError,
      );
      await assertRejects(
        () => saveDomainLlmQuota(school.slug, owner, total("new-id", null), 1),
        ForbiddenError,
      );
      assertEquals(writes, 1);
      assertEquals(
        await saveDomainLlmQuota(school.slug, owner, {
          id: "user",
          scope_type: "user",
          scope_id: owner,
          window_type: "day",
          max_calls: 20,
          max_tokens: null,
          max_cost: null,
        }, 1),
        { id: "user", revision: 2 },
      );
      assertEquals(
        await saveDomainLlmQuota(school.slug, admin, total("current", 80), 2),
        { id: "current", revision: 3 },
      );
      await assertRejects(
        () => saveDomainLlmQuota(school.slug, admin, total("current", 101), 1),
        BadRequestError,
      );
      assertEquals(writes, 3);
    } finally {
      globalThis.fetch = original;
      if (token === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
      else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", token);
    }
  },
});

Deno.test({
  name: "域 LLM：用量只返回metadata白名单，不返回evaluator正文和任意详情",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await resetDbForTest();
    const actor = await account(true),
      school = await createDomain({
        slug: "llm-safe-usage",
        name: "用量学校",
        preset: "education",
      }, actor);
    const original = globalThis.fetch,
      previousToken = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
    Deno.env.set(
      "NOJ_LLM_SERVICE_TOKEN",
      "domain-test-secret-0123456789abcdef",
    );
    globalThis.fetch = (_input, init) => {
      assertEquals(
        new Headers(init?.headers).get("X-Noj-Domain-Id"),
        school.id,
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{
              id: "usage",
              domain_id: school.id,
              model: "school-model",
              total_tokens: 3,
              estimated_cost: 1,
              request_messages: [{ content: "secret-source-answer" }],
              request_params: { hidden: "secret-source-answer" },
              prompt_hash: "private-hash",
              details: { output: "secret-source-answer" },
              output: "secret-source-answer",
            }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    };
    try {
      const rows = await readDomainLlmUsage(school.slug, actor, {
        page: 1,
        limit: 10,
      });
      assertEquals(rows[0].model, "school-model");
      assertEquals(rows[0].total_tokens, 3);
      assertEquals("request_messages" in rows[0], false);
      assertEquals("details" in rows[0], false);
      assertEquals(
        JSON.stringify(rows).includes("secret-source-answer"),
        false,
      );
      assertEquals(JSON.stringify(rows).includes("private-hash"), false);
    } finally {
      globalThis.fetch = original;
      if (previousToken === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
      else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", previousToken);
    }
  },
});

Deno.test({
  name: "域 LLM：域配额真实实例上限约束，数值或null不能越过，降低可提交",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await resetDbForTest();
    const actor = await account(true);
    const school = await createDomain({
      slug: "quota-cap-school",
      name: "额度学校",
      preset: "education",
    }, actor);
    const limits = {
      day: { max_calls: 3, max_tokens: 100, max_cost: null },
      month: { max_calls: null, max_tokens: null, max_cost: null },
    };
    await getDb().insert(systemSettings).values({
      key: "domain_llm_quota_caps",
      value: JSON.stringify(JSON.stringify(limits)),
      updated_at: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: JSON.stringify(JSON.stringify(limits)) },
    });
    const original = globalThis.fetch,
      previousToken = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
    Deno.env.set(
      "NOJ_LLM_SERVICE_TOKEN",
      "domain-test-secret-0123456789abcdef",
    );
    let calls = 0;
    globalThis.fetch = () => {
      calls++;
      return Promise.resolve(
        new Response(JSON.stringify({ data: { id: "quota", revision: 1 } }), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    try {
      await assertRejects(
        () =>
          saveDomainLlmQuota(school.slug, actor, {
            scope_type: "domain",
            max_calls: 4,
            max_tokens: 100,
            max_cost: null,
          }, 0),
        BadRequestError,
      );
      await assertRejects(
        () =>
          saveDomainLlmQuota(school.slug, actor, {
            scope_type: "domain",
            max_calls: null,
            max_tokens: 100,
            max_cost: null,
          }, 0),
        BadRequestError,
      );
      assertEquals(calls, 0);
      assertEquals(
        await saveDomainLlmQuota(school.slug, actor, {
          scope_type: "domain",
          max_calls: 2,
          max_tokens: 99,
          max_cost: null,
        }, 0),
        { id: "quota", revision: 1 },
      );
      assertEquals(calls, 1);
    } finally {
      globalThis.fetch = original;
      if (previousToken === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
      else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", previousToken);
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
