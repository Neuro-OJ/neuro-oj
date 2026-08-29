import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { resetDbForTest } from "../../src/db/connection.ts";

const originalEnv = new Map<string, string | undefined>();
function configure() {
  for (
    const [key, value] of Object.entries({
      JWT_SECRET: "oauth-route-test-secret-that-is-long-enough",
      OAUTH_GITHUB_CLIENT_ID: "github-client",
      OAUTH_GITHUB_CLIENT_SECRET: "github-secret",
      APP_URL: "http://localhost:3000",
    })
  ) {
    if (!originalEnv.has(key)) originalEnv.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }
}
function restore() {
  for (const [key, value] of originalEnv) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  originalEnv.clear();
}

Deno.test({
  name: "oauth route: provider list and state mismatch are safe",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    configure();
    try {
      const app = createApp();
      const providers = await app.fetch(
        new Request("http://localhost/api/v1/auth/oauth/providers"),
      );
      assertEquals(providers.status, 200);
      assertEquals((await providers.json()).data, [{
        id: "github",
        name: "GitHub",
      }]);

      const start = await app.fetch(
        new Request("http://localhost/api/v1/auth/oauth/github"),
      );
      assertEquals(start.status, 302);
      assertEquals(
        start.headers.get("location")?.startsWith(
          "https://github.com/login/oauth/authorize",
        ),
        true,
      );
      const stateCookie = start.headers.get("set-cookie");
      assertEquals(stateCookie?.includes("noj_oauth_state"), true);
      const cookieValue = stateCookie?.split(";")[0] ?? "";
      const callback = await app.fetch(
        new Request(
          "http://localhost/api/v1/auth/oauth/github/callback?state=wrong&code=unused",
          {
            headers: { cookie: cookieValue },
          },
        ),
      );
      assertEquals(callback.status, 302);
      assertEquals(
        callback.headers.get("location")?.includes("oauth_error=state_invalid"),
        true,
      );
      assertEquals(
        callback.headers.get("set-cookie")?.includes("Max-Age=0"),
        true,
      );
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "oauth route: GitHub callback provisions a user and sets JWT cookies",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    configure();
    const originalFetch = globalThis.fetch;
    try {
      await resetDbForTest();
      const app = createApp();
      const start = await app.fetch(
        new Request("http://localhost/api/v1/auth/oauth/github"),
      );
      const stateCookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
      const state = new URL(start.headers.get("location")!).searchParams.get(
        "state",
      )!;

      globalThis.fetch = ((input: Request | URL | string) => {
        const url = String(input);
        if (url.endsWith("/login/oauth/access_token")) {
          return Promise.resolve(
            Response.json({ access_token: "mock-access-token" }),
          );
        }
        if (url.endsWith("/user/emails")) {
          return Promise.resolve(Response.json([{
            email: "mock-github@example.com",
            primary: true,
            verified: true,
          }]));
        }
        if (url.endsWith("/user")) {
          return Promise.resolve(
            Response.json({ id: 12345, login: "mock_github_user" }),
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      }) as typeof fetch;

      const callback = await app.fetch(
        new Request(
          `http://localhost/api/v1/auth/oauth/github/callback?state=${
            encodeURIComponent(state)
          }&code=mock-code`,
          { headers: { cookie: stateCookie } },
        ),
      );
      assertEquals(callback.status, 302);
      assertEquals(
        callback.headers.get("location"),
        "http://localhost:3000/set-password",
      );
      const cookies = typeof callback.headers.getSetCookie === "function"
        ? callback.headers.getSetCookie().join(";")
        : callback.headers.get("set-cookie") ?? "";
      assertEquals(cookies.includes("noj:token="), true);
      assertEquals(cookies.includes("noj:session="), true);
      assertEquals(cookies.includes("mock-access-token"), false);
    } finally {
      globalThis.fetch = originalFetch;
      restore();
    }
  },
});
