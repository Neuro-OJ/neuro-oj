// 构建后验收：独立模拟 Core，检查真实 Nitro SSR、浏览器水合与请求数量。
import { chromium } from "playwright";
import { strict as assert } from "node:assert";

const requests = [];
let brokenCarousel = false;
let draftAssignment = false;
const user = (id) => ({
  id,
  username: id,
  email: `${id}@test.invalid`,
  role: "user",
  is_admin: false,
  must_change_password: false,
  email_verified: true,
  has_local_password: true,
  created_at: "2026-10-01",
  updated_at: "2026-10-01",
});
const page = { data: [], total: 0, page: 1, per_page: 50 };
const fixture = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen() {} },
  (request) => {
    const url = new URL(request.url), path = url.pathname;
    const actor =
      request.headers.get("authorization")?.replace("Bearer ", "") ?? null;
    requests.push({ path, actor, query: url.search });
    if (path.endsWith("/events")) {
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(": ready\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (path === "/api/v1/auth/me") return Response.json({ data: user(actor) });
    if (path === "/api/v1/me/domains") return Response.json({ data: [] });
    if (path === "/api/v1/conversations/unread-count") {
      return Response.json({
        unread_count: 0,
      });
    }
    if (path === "/api/v1/site/meta") {
      return Response.json({
        data: {
          icp_number: "测试备案",
          icp_url: "",
          police_number: "",
          police_url: "",
          build: null,
        },
      });
    }
    if (path === "/api/v1/instance") {
      return Response.json({
        data: { access: "public", default_domain_slug: "school", modules: {} },
      });
    }
    if (path === "/api/v1/auth/ban-status") {
      return Response.json({
        ip_banned: false,
        user_banned: false,
      });
    }
    if (/^\/api\/v1\/domains\/[^/]+$/.test(path)) {
      if (path.endsWith("/missing")) {
        return Response.json({ error: "空间不存在", code: "NOT_FOUND" }, {
          status: 404,
        });
      }
      if (path.endsWith("/forbidden")) {
        return Response.json({ error: "没有访问权限", code: "FORBIDDEN" }, {
          status: 403,
        });
      }
      return Response.json({
        data: {
          id: "domain",
          slug: url.pathname.split("/").pop(),
          name: "空间首屏",
          description: "SSR 检查",
          status: "active",
          preset: "school",
          owner_id: "owner",
          revision: 1,
          actor_id: actor,
          is_member: !!actor,
          platform_admin: false,
          permissions: actor === "coach" ? ["classroom:create"] : [],
          configuration: {
            access: "public",
            discoverable: true,
            join_policy: "invite",
            homepage: "education",
            features: {
              community: true,
              classroom: true,
              assignment: true,
              analytics: false,
            },
          },
        },
      });
    }
    if (path.endsWith("/community/config")) {
      return Response.json({
        data: {
          enabled: true,
          follows_enabled: true,
          moments_enabled: true,
          guest_read_enabled: true,
          permissions: {},
        },
      });
    }
    if (path.endsWith("/community/notifications/unread-count")) {
      return Response
        .json({ data: { count: 3 } });
    }
    if (path.endsWith("/notifications")) {
      return Response.json({
        data: { ...page, unread: 2 },
      });
    }
    if (path.endsWith("/carousel/slides")) {
      return brokenCarousel
        ? Response.json({ error: "轮播暂不可用" }, { status: 503 })
        : Response.json({
          data: [{
            id: "slide",
            kind: "text",
            title: "轮播首屏",
            subtitle: "聚合返回的内容",
            gradient_key: "sky",
            image_storage_url: null,
            link_url: null,
            sort_order: 0,
            is_enabled: true,
          }],
        });
    }
    if (path.endsWith("/announcements/banner")) {
      return Response.json({
        data: null,
      });
    }
    if (path.endsWith("/announcements")) {
      return Response.json({
        data: [{
          id: "notice",
          title: "公告首屏",
          excerpt: "公告摘要",
          domain_id: "domain",
          scope: "domain",
          is_pinned: false,
          created_at: "2026-10-01",
        }],
        meta: { page: 1, total: 1, total_pages: 1 },
      });
    }
    if (path.endsWith("/problems")) {
      return Response.json({
        total: 1,
        items: [{
          binding_id: "problem",
          title: "题目首屏",
          kind: "oi",
          version: 1,
          reference: { display_ref: "1001" },
        }],
      });
    }
    if (path.endsWith("/activity")) {
      return Response.json({
        data: {
          recent: [],
          today: { total: 0, full_score: 0, not_full_score: 0 },
          total: { total: 0, full_score: 0, not_full_score: 0 },
        },
      });
    }
    if (path.endsWith("/checkin/today")) {
      return Response.json({
        data: { checked_in: false, streak: 2 },
      });
    }
    if (
      path.endsWith("/my-learning") || path.endsWith("/teaching")
    ) return Response.json({ data: { assignments: [] } });
    if (path.endsWith("/community/feed")) return Response.json({ data: [] });
    if (path.endsWith("/classrooms/c")) {
      return Response.json({
        data: {
          id: "c",
          domain_id: "domain",
          name: "班级首屏",
          description: "班级说明",
          stage_tag: "",
          status: "active",
          revision: 1,
          primary_coach_id: "coach",
          membership: { role: actor, status: "active" },
          manages_domain: false,
          capabilities: [],
        },
      });
    }
    if (path.endsWith("/classrooms/c/members")) {
      return Response.json({
        data: [],
      });
    }
    if (path.endsWith("/classrooms/c/assignments")) {
      return Response.json({
        data: [],
      });
    }
    if (path.endsWith("/assignments/a")) {
      return Response.json({
        data: {
          id: "a",
          classroom_id: "c",
          title: "作业首屏",
          description: "作业说明",
          state: draftAssignment ? "draft" : "published",
          revision: 1,
          published_at: draftAssignment ? null : "2026-10-01",
          source_training_id: null,
          deadline_at: null,
          items: [],
        },
      });
    }
    if (path.endsWith("/matrix")) {
      return Response.json({
        data: {
          ...page,
          items: [],
          rows: [],
          updating: false,
          scope: "on_time",
        },
      });
    }
    if (path.endsWith("/progress")) {
      return Response.json({
        data: {
          items: [],
          cells: [],
          updating: false,
          scope: "on_time",
          recipient_status: "active",
        },
      });
    }
    if (/\/(feedback|help-requests|history)$/.test(path)) {
      return Response.json(
        { data: page },
      );
    }
    return Response.json({ error: `未配置模拟接口 ${path}` }, { status: 404 });
  },
);
const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
const port = listener.addr.port;
listener.close();
const base = `http://127.0.0.1:${port}`;
const logPath = await Deno.makeTempFile({
  prefix: "noj-bff-ssr-",
  suffix: ".log",
});
const log = await Deno.open(logPath, { write: true });
const process = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "-A",
    "--unstable-byonm",
    "--unstable-node-globals",
    ".output/server/index.mjs",
  ],
  env: {
    PORT: String(port),
    HOST: "127.0.0.1",
    NUXT_API_BASE: `http://127.0.0.1:${fixture.addr.port}`,
    NUXT_BFF_REDIS_URL: "",
    NUXT_NOJ_ENV: "development",
    NODE_ENV: "production",
  },
  stdout: "piped",
  stderr: "piped",
}).spawn();
const stdout = process.stdout.pipeTo(log.writable, { preventClose: true });
const stderr = process.stderr.pipeTo(
  new WritableStream({
    write(chunk) {
      return Deno.stderr.write(chunk).then(() => {});
    },
  }),
);
let browser;
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/bff/v1/domains/school/home`);
      if (r.ok) {
        await r.arrayBuffer();
        ready = true;
        break;
      }
    } catch { /* 等待服务监听 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, `生产构建未就绪，日志：${logPath}`);
  const html = await (await fetch(`${base}/d/school`)).text();
  for (const text of ["空间首屏", "轮播首屏", "公告首屏", "题目首屏"]) {
    assert(html.includes(text), `SSR 缺少 ${text}`);
  }
  assert.equal((await fetch(`${base}/d/missing`)).status, 404);
  assert.equal((await fetch(`${base}/d/forbidden`)).status, 403);
  const unauthenticated = await fetch(`${base}/d/school/classrooms/c`, {
    redirect: "manual",
  });
  assert.equal(unauthenticated.status, 302);
  assert(unauthenticated.headers.get("location")?.startsWith("/login"));
  for (const path of ["/settings", "/admin", "/d/school/solve/1001"]) {
    const shell = await (await fetch(base + path)).text();
    assert(
      !shell.includes("轮播首屏") && !shell.includes("个人资料编辑"),
      `${path} 应仅返回客户端外壳`,
    );
  }
  browser = await chromium.launch({ headless: true });
  for (const role of ["guest", "student", "coach", "assistant"]) {
    const context = await browser.newContext();
    if (role !== "guest") {
      await context.addCookies([
        { name: "noj:token", value: role, url: base },
        {
          name: "noj:session",
          value: JSON.stringify({ ...user(role), userId: role }),
          url: base,
        },
      ]);
    }
    const tab = await context.newPage();
    const errors = [], api = [];
    tab.on("pageerror", (error) => errors.push(error.message));
    tab.on("console", (message) => {
      if (/hydration/i.test(message.text())) errors.push(message.text());
    });
    tab.on("request", (request) => {
      if (/^\/api\/(bff|v1)\//.test(new URL(request.url()).pathname)) {
        api.push(new URL(request.url()).pathname);
      }
    });
    const paths = role === "guest"
      ? ["/d/school"]
      : ["/d/school", "/d/school/classrooms/c", "/d/school/assignments/a"];
    for (const path of paths) {
      requests.length = 0;
      api.length = 0;
      const documentResponse = await tab.goto(base + path, {
        waitUntil: "domcontentloaded",
      });
      assert.equal(
        documentResponse.status(),
        200,
        `${role} ${path} 应成功渲染`,
      );
      await tab.waitForFunction(() =>
        document.querySelector("#__nuxt")?.__vue_app__
      );
      await tab.waitForTimeout(200);
      assert.deepEqual(errors, [], `${role} ${path} 水合错误`);
      const expectedTitle = path.endsWith("/classrooms/c")
        ? "班级首屏"
        : path.endsWith("/assignments/a")
        ? "作业首屏"
        : "轮播首屏";
      assert(
        (await tab.locator("body").innerText()).includes(expectedTitle),
        `${role} ${path} 未显示主要内容`,
      );
      const initialApi = api.filter((path) => !path.endsWith("/events"));
      assert.deepEqual(
        initialApi,
        [],
        `${role} ${path} 水合重复请求：${initialApi}`,
      );
      assert.equal(
        requests.filter((request) => request.path === "/api/v1/auth/me").length,
        role === "guest" ? 0 : 1,
      );
      if (path.endsWith("/assignments/a")) {
        assert.equal(
          requests.some((request) => request.path.endsWith("/progress")),
          role === "student",
        );
        assert.equal(
          requests.some((request) => request.path.endsWith("/matrix")),
          role === "coach",
        );
      }
      const counts = new Map();
      for (
        const request of requests.filter((request) =>
          !request.path.endsWith("/events")
        )
      ) {
        const params = new URLSearchParams(request.query);
        params.sort();
        const key = `${request.actor}:${request.path}?${params}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      assert.deepEqual(
        [...counts].filter(([, count]) => count > 1),
        [],
        `${role} ${path} Core 重复请求`,
      );
      console.log(
        JSON.stringify({
          role,
          path,
          coreRequests: requests.filter((request) =>
            !request.path.endsWith("/events")
          ).length,
          hydrationApiRequests: initialApi.length,
        }),
      );
    }
    if (role === "coach") {
      api.length = 0;
      await tab.getByRole("button", { name: "刷新成绩" }).click();
      await tab.waitForTimeout(200);
      assert(api.some((path) => path.endsWith("/matrix")));
      assert(
        !api.some((path) => path.startsWith("/api/bff/")),
        "局部刷新不重新聚合整个视图",
      );
    }
    // 通过 NuxtLink 进行 SPA 导航，初次数据只发送一个 BFF 请求。
    await tab.goto(base + "/d/school");
    await tab.waitForFunction(() =>
      document.querySelector("#__nuxt")?.__vue_app__?.config.globalProperties
        .$nuxt?.isHydrating === false
    );
    await tab.waitForTimeout(100);
    api.length = 0;
    await tab.evaluate(() => {
      const app = document.querySelector("#__nuxt").__vue_app__;
      return app.config.globalProperties.$router.push("/d/another");
    });
    await tab.waitForTimeout(300);
    assert.equal(api.filter((path) => path.startsWith("/api/bff/")).length, 1);
    assert(
      await tab.locator('a[href="/d/another/problems"]').count(),
      "跨空间导航应显示目标空间链接",
    );
    assert.equal(
      api.filter((path) =>
        !path.startsWith("/api/bff/") && !path.endsWith("/events")
      ).length,
      0,
      `SPA 组件额外取数：${api}`,
    );
    await context.close();
  }
  draftAssignment = true;
  const draftContext = await browser.newContext();
  await draftContext.addCookies([{
    name: "noj:token",
    value: "coach",
    url: base,
  }, {
    name: "noj:session",
    value: JSON.stringify({ ...user("coach"), userId: "coach" }),
    url: base,
  }]);
  const draftTab = await draftContext.newPage();
  const draftApi = [];
  draftTab.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/(v1|bff)\//.test(path) && !path.endsWith("/events")) {
      draftApi.push(path);
    }
  });
  const draftResponse = await draftTab.goto(base + "/d/school/assignments/a");
  assert.equal(draftResponse.status(), 200);
  await draftTab.waitForFunction(() =>
    document.querySelector("#__nuxt")?.__vue_app__?.config.globalProperties
      .$nuxt?.isHydrating === false
  );
  assert((await draftTab.locator("body").innerText()).includes("发布预览"));
  assert.deepEqual(draftApi, [], "草稿预览也应复用聚合数据");
  await draftContext.close();
  brokenCarousel = true;
  const degraded = await fetch(`${base}/api/bff/v1/domains/school/home`);
  assert.equal(degraded.status, 200);
  assert.equal((await degraded.json()).sections.carousel.error.statusCode, 503);
  console.log(
    "BFF 生产 SSR、身份分支、浏览器水合、SPA 单请求和局部刷新验收通过",
  );
} finally {
  await browser?.close();
  process.kill("SIGTERM");
  await process.status;
  await stdout;
  await stderr;
  log.close();
  await fixture.shutdown();
}
