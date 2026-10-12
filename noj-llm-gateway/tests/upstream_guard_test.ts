import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1";
import {
  assertResolvesPublic,
  assertSafeBaseUrl,
  isPrivateAddress,
  parseAllowedHosts,
  UPSTREAM_BLOCKED,
} from "../src/upstream-guard.ts";
import { createInternalRouter } from "../src/routes/internal.ts";
import { createLlmRouter } from "../src/routes/llm.ts";
import { testProviderConnection } from "../src/providers.ts";
import type { Db } from "../src/db.ts";
import {
  createFakeDb,
  FakeRedis,
  makeProvider,
  makeToken,
  requestChat,
  stubFetch,
  testConfig,
} from "./helpers.ts";

const none = new Set<string>();

Deno.test("upstream guard: 内网 / 回环 / 元数据 IP 判定", () => {
  for (
    const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "::ffff:7f00:1",
      "[::1]",
      "64:ff9b::a00:1",
    ]
  ) {
    assertEquals(isPrivateAddress(ip), true, ip);
  }
  for (
    const ip of [
      "8.8.8.8",
      "172.32.0.1",
      "192.0.3.1",
      "198.18.0.10",
      "2606:4700::1111",
      "api.openai.com",
    ]
  ) {
    assertEquals(isPrivateAddress(ip), false, ip);
  }
});

Deno.test("upstream guard: 登记时拒绝非 https、内嵌凭据、内网主机名与内网 IP", () => {
  for (
    const url of [
      "http://api.openai.com/v1",
      "https://user:pass@api.openai.com/v1",
      "https://localhost/v1",
      "https://noj-postgres:5432",
      "https://noj-core/v1",
      "https://metadata.google.internal/computeMetadata",
      "https://foo.internal/v1",
      "https://printer.local/v1",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/v1",
      "https://[::1]/v1",
      "ftp://api.openai.com",
      "not a url",
    ]
  ) {
    assertThrows(() => assertSafeBaseUrl(url, none), Error, UPSTREAM_BLOCKED);
  }
  assertSafeBaseUrl("https://api.openai.com/v1", none);
  assertSafeBaseUrl("https://api.deepseek.com", none);
  assertSafeBaseUrl("https://8.8.8.8/v1", none);
});

Deno.test("upstream guard: 白名单主机允许 http 与内网地址", () => {
  const allowed = parseAllowedHosts(" noj-e2e-llm-mock , 10.0.0.5 ");
  assertSafeBaseUrl("http://noj-e2e-llm-mock:8002/v1", allowed);
  assertSafeBaseUrl("http://10.0.0.5:8000/v1", allowed);
  // 白名单不放宽凭据与协议
  assertThrows(
    () => assertSafeBaseUrl("http://u:p@noj-e2e-llm-mock/v1", allowed),
    Error,
    UPSTREAM_BLOCKED,
  );
});

Deno.test("upstream guard: 调用时解析到内网即拒绝（防 DNS 指向内网）", async () => {
  const toPrivate = (_h: string, t: "A" | "AAAA") =>
    Promise.resolve(t === "A" ? ["93.184.216.34", "10.0.0.8"] : []);
  await assertRejects(
    () => assertResolvesPublic("https://evil.example.com/v1", none, toPrivate),
    Error,
    UPSTREAM_BLOCKED,
  );
  const v6Private = (_h: string, t: "A" | "AAAA") =>
    Promise.resolve(t === "AAAA" ? ["fd00::2"] : []);
  await assertRejects(
    () => assertResolvesPublic("https://evil.example.com/v1", none, v6Private),
    Error,
    UPSTREAM_BLOCKED,
  );
  // 两类记录都解析失败：无法证明为公网，失败关闭
  const fail = () => Promise.reject(new Error("NXDOMAIN"));
  await assertRejects(
    () => assertResolvesPublic("https://nx.example.com/v1", none, fail),
    Error,
    UPSTREAM_BLOCKED,
  );
  const pub = (_h: string, t: "A" | "AAAA") =>
    Promise.resolve(t === "A" ? ["93.184.216.34"] : []);
  await assertResolvesPublic("https://api.example.com/v1", none, pub);
  // 白名单主机不解析
  await assertResolvesPublic(
    "http://noj-e2e-llm-mock:8002/v1",
    parseAllowedHosts("noj-e2e-llm-mock"),
    fail,
  );
});

Deno.test("upstream guard: /internal/providers 新建与更新拒绝内网 base_url", async () => {
  const writes: string[] = [];
  const db = Object.assign(
    (strings: TemplateStringsArray) => {
      const q = strings.join("?");
      if (q.includes("INSERT") || q.includes("UPDATE")) writes.push(q);
      return Promise.resolve([]);
    },
    {
      unsafe: (q: string) => {
        writes.push(q);
        return Promise.resolve([]);
      },
    },
  ) as unknown as Db;
  const app = createInternalRouter({ config: testConfig, db });
  const headers = {
    Authorization: `Bearer ${testConfig.serviceToken}`,
    "Content-Type": "application/json",
  };
  const created = await app.request("/internal/providers", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "x",
      base_url: "http://169.254.169.254/latest",
      api_key: "sk-test",
    }),
  });
  assertEquals(created.status, 400);
  assertEquals((await created.json()).error, UPSTREAM_BLOCKED);

  const updated = await app.request("/internal/providers/prov-1", {
    method: "PUT",
    headers,
    body: JSON.stringify({ base_url: "https://noj-core:8000" }),
  });
  assertEquals(updated.status, 400);
  assertEquals((await updated.json()).error, UPSTREAM_BLOCKED);
  assertEquals(writes.length, 0);
});

Deno.test("upstream guard: 存量 Provider 指向内网时调用被拦截且不访问上游", async () => {
  const provider = {
    ...(await makeProvider(testConfig.storeKey)),
    base_url: "https://llm.attacker.example/v1",
  };
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: (_h, t) => Promise.resolve(t === "A" ? ["10.0.0.20"] : []),
  });
  let fetched = false;
  const restore = stubFetch(() => {
    fetched = true;
    return Promise.resolve(new Response("{}"));
  });
  try {
    const res = await requestChat(app, await makeToken(testConfig), {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "ping" }],
    });
    assertEquals(res.status, 502);
    assertEquals((await res.json()).error, UPSTREAM_BLOCKED);
    assertEquals(fetched, false);
    assertEquals(usageInserts.length, 0);
  } finally {
    restore();
  }
});

Deno.test("upstream guard: 连通性测试对内网目标拒绝且不发起请求", async () => {
  const provider = {
    ...(await makeProvider(testConfig.storeKey)),
    base_url: "https://scan.attacker.example/v1",
  };
  const { db } = createFakeDb(provider);
  let fetched = false;
  const restore = stubFetch(() => {
    fetched = true;
    return Promise.resolve(new Response("{}"));
  });
  try {
    await assertRejects(
      () =>
        testProviderConnection(
          db,
          provider.id,
          testConfig.storeKey,
          "deepseek-chat",
          none,
          (_h, t) => Promise.resolve(t === "A" ? ["192.168.1.10"] : []),
        ),
      Error,
      UPSTREAM_BLOCKED,
    );
    assertEquals(fetched, false);
  } finally {
    restore();
  }
});
