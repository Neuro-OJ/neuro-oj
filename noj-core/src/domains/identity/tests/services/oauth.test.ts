import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  consumeOAuthState,
  createOAuthAuthorization,
  fetchOAuthIdentity,
  listOAuthProviders,
} from "../../index.ts";

const original = new Map<string, string | undefined>();
function setOAuthEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (!original.has(key)) original.set(key, Deno.env.get(key));
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

function restoreOAuthEnv() {
  for (const [key, value] of original) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  original.clear();
}

Deno.test("oauth: only complete providers are exposed", () => {
  setOAuthEnv({
    OAUTH_GITHUB_CLIENT_ID: "github-id",
    OAUTH_GITHUB_CLIENT_SECRET: "github-secret",
    OAUTH_OIDC_ISSUER_URL: "",
    OAUTH_OIDC_CLIENT_ID: "",
    OAUTH_OIDC_CLIENT_SECRET: "",
  });
  try {
    assertEquals(listOAuthProviders(), [{ id: "github", name: "GitHub" }]);
  } finally {
    restoreOAuthEnv();
  }
});

Deno.test("oauth: state is bound to cookie and can only be consumed once", async () => {
  setOAuthEnv({
    JWT_SECRET: "oauth-test-secret-that-is-long-enough-for-hs256",
    OAUTH_GITHUB_CLIENT_ID: "github-id",
    OAUTH_GITHUB_CLIENT_SECRET: "github-secret",
    APP_URL: "http://localhost:3000",
  });
  try {
    const result = await createOAuthAuthorization(
      "github",
      "login",
      "http://localhost:8000/api/v1/auth/oauth/github",
    );
    const url = new URL(result.url);
    assertEquals(url.origin, "https://github.com");
    assertEquals(url.searchParams.get("state"), result.state);
    assertEquals(
      url.searchParams.get("redirect_uri"),
      "http://localhost:3000/api/v1/auth/oauth/github/callback",
    );

    const state = await consumeOAuthState(
      "github",
      result.state,
      result.cookieValue,
    );
    assertEquals(state.intent, "login");
    await assertRejects(
      () => consumeOAuthState("github", result.state, result.cookieValue),
      Error,
      "OAuth state 已使用",
    );
    await assertRejects(
      () => consumeOAuthState("github", result.state, "different-cookie"),
      Error,
      "OAuth state 无效或已过期",
    );
  } finally {
    restoreOAuthEnv();
  }
});

Deno.test("oauth: OIDC authorization uses discovered endpoints", async () => {
  setOAuthEnv({
    JWT_SECRET: "oauth-oidc-test-secret-that-is-long-enough-for-hs256",
    OAUTH_GITHUB_CLIENT_ID: undefined,
    OAUTH_GITHUB_CLIENT_SECRET: undefined,
    OAUTH_OIDC_ISSUER_URL: "https://issuer.example",
    OAUTH_OIDC_CLIENT_ID: "oidc-client",
    OAUTH_OIDC_CLIENT_SECRET: "oidc-secret",
    OAUTH_OIDC_NAME: "企业登录",
    APP_URL: "http://localhost:3000",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(Response.json({
      authorization_endpoint: "https://issuer.example/authorize",
      token_endpoint: "https://issuer.example/token",
      userinfo_endpoint: "https://issuer.example/userinfo",
    }))) as typeof fetch;
  try {
    const result = await createOAuthAuthorization(
      "oidc",
      "login",
      "http://localhost:8000/api/v1/auth/oauth/oidc",
    );
    const url = new URL(result.url);
    assertEquals(url.origin, "https://issuer.example");
    assertEquals(url.pathname, "/authorize");
    assertEquals(url.searchParams.get("client_id"), "oidc-client");
    assertEquals(url.searchParams.get("scope"), "openid profile email");
  } finally {
    globalThis.fetch = originalFetch;
    restoreOAuthEnv();
  }
});

Deno.test("oauth: OIDC rejects issuer mismatch and failed userinfo", async () => {
  setOAuthEnv({
    JWT_SECRET: "oauth-oidc-validation-secret-that-is-long-enough",
    OAUTH_GITHUB_CLIENT_ID: undefined,
    OAUTH_GITHUB_CLIENT_SECRET: undefined,
    OAUTH_OIDC_ISSUER_URL: "https://issuer.example",
    OAUTH_OIDC_CLIENT_ID: "oidc-client",
    OAUTH_OIDC_CLIENT_SECRET: "oidc-secret",
  });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(Response.json({
        issuer: "https://another-issuer.example",
        authorization_endpoint: "https://issuer.example/authorize",
        token_endpoint: "https://issuer.example/token",
      }))) as typeof fetch;
    await assertRejects(
      () => createOAuthAuthorization("oidc", "login", "http://localhost"),
      Error,
      "OIDC provider issuer 校验失败",
    );

    globalThis.fetch = ((input: Request | URL | string) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Promise.resolve(Response.json({
          issuer: "https://issuer.example",
          authorization_endpoint: "https://issuer.example/authorize",
          token_endpoint: "https://issuer.example/token",
          userinfo_endpoint: "https://issuer.example/userinfo",
        }));
      }
      if (url.endsWith("/token")) {
        return Promise.resolve(Response.json({ access_token: "token" }));
      }
      return Promise.resolve(new Response("failed", { status: 503 }));
    }) as typeof fetch;
    await assertRejects(
      () => fetchOAuthIdentity("oidc", "code", "http://localhost"),
      Error,
      "OIDC 用户信息获取失败",
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreOAuthEnv();
  }
});
