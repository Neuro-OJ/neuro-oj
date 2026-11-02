import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1";
import {
  assertResolvesPublic,
  assertSafeBaseUrl,
  fetchPinned,
  isPrivateAddress,
  parseAllowedHosts,
  resetRequestImplementations,
  resolvePublicUpstream,
  setPinnedTransport,
  setRequestImplementations,
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
    headers: { ...headers, "If-Match": "0" },
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
    headers: { ...headers, "If-Match": "1" },
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

// ── 审计 R1：DNS 校验与连接绑定 ─────────────────────────────────────
Deno.test("resolvePublicUpstream: 返回已验证地址，供连接层固定", async () => {
  const resolution = await resolvePublicUpstream(
    "https://api.example.com/v1",
    new Set(),
    (host) =>
      Promise.resolve(host === "api.example.com" ? ["93.184.216.34"] : []),
  );
  assertEquals(resolution.host, "api.example.com");
  assertEquals(resolution.addresses, ["93.184.216.34"]);
});

Deno.test("resolvePublicUpstream: 私网地址直接拒绝", async () => {
  await assertRejects(() =>
    resolvePublicUpstream(
      "https://evil.example.com/v1",
      new Set(),
      () => Promise.resolve(["10.0.0.5"]),
    )
  );
});

Deno.test("resolvePublicUpstream: A/AAAA 重叠地址去重（双栈主机不留重复项）", async () => {
  // 双栈主机：A 与 AAAA 各取到公网地址，两条都保留。
  const dual = await resolvePublicUpstream(
    "https://dual.example.com/v1",
    new Set(),
    (_host, type) =>
      Promise.resolve(
        type === "A"
          ? ["93.184.216.34"]
          : ["2606:2800:220:1:248:1893:25c8:1946"],
      ),
  );
  assertEquals(dual.addresses, [
    "93.184.216.34",
    "2606:2800:220:1:248:1893:25c8:1946",
  ]);
  // 解析器对两种查询返回同一地址（常见于桩/缓存）：去重后只剩一条。
  const overlap = await resolvePublicUpstream(
    "https://dual.example.com/v1",
    new Set(),
    () => Promise.resolve(["93.184.216.34"]),
  );
  assertEquals(overlap.addresses, ["93.184.216.34"]);
});

Deno.test("fetchPinned: 连接使用 lookup 固定的已校验地址（rebinding 无法改变目标）", () => {
  // 若连接阶段重新解析 DNS，测试里的 lookup 会读到注入的第二批地址；固定后
  // lookup 只可能拿到校验过的地址。
  const seen: string[] = [];
  const fakeRequest = ((
    options: { lookup?: unknown },
    _cb: unknown,
  ) => {
    const lookup = options.lookup as (
      h: string,
      o: { all?: boolean },
      cb: (e: null, a: unknown, f?: number) => void,
    ) => void;
    lookup("api.example.com", { all: false }, (_e, address) => {
      seen.push(String(address));
    });
    return { on: () => {}, write: () => {}, end: () => {} } as never;
  }) as never;
  setRequestImplementations(fakeRequest, fakeRequest);
  try {
    // 请求不会真正完成（fake 从不回调），这里只验证 lookup 被固定
    void fetchPinned(
      "https://api.example.com/v1/chat",
      { method: "POST", body: "{}" },
      { addresses: ["93.184.216.34"], host: "api.example.com" },
    ).catch(() => {});
    assertEquals(seen, ["93.184.216.34"]);
  } finally {
    resetRequestImplementations();
  }
});

Deno.test("fetchPinned: 传输层可注入，且调用方拿到已验证地址（路由接线契约）", async () => {
  const calls: Array<{ url: string; addresses: string[] }> = [];
  setPinnedTransport((url, _init, resolution) => {
    calls.push({ url, addresses: resolution.addresses });
    return Promise.resolve(new Response("pinned", { status: 200 }));
  });
  try {
    const res = await fetchPinned(
      "https://api.example.com/v1/chat/completions",
      { method: "POST", body: "{}" },
      { addresses: ["93.184.216.34"], host: "api.example.com" },
    );
    assertEquals(await res.text(), "pinned");
    assertEquals(calls, [{
      url: "https://api.example.com/v1/chat/completions",
      addresses: ["93.184.216.34"],
    }]);
  } finally {
    setPinnedTransport();
  }
});
