import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { AppError } from "../../../../shared/base/errors.ts";
import {
  adminVersionMiddleware,
  readVersion,
} from "../../middleware/admin-version.ts";
import {
  assertVersion,
  VersionConflictError,
} from "../../services/admin-version.ts";

Deno.test({
  name: "admin-version: readVersion 从 If-Match 读取并去引号",
  fn: async () => {
    const app = new Hono();
    app.get("/test", (c) => {
      return c.json({ version: readVersion(c) });
    });
    const res = await app.request("http://localhost/test", {
      headers: { "If-Match": '"2026-09-07T00:00:00.000Z"' },
    });
    const body = await res.json();
    assertEquals(body.version, "2026-09-07T00:00:00.000Z");
  },
});

Deno.test({
  name: "admin-version: assertVersion 不匹配时抛 VersionConflictError",
  fn: () => {
    let threw = false;
    try {
      assertVersion("old", "new");
    } catch (e) {
      threw = e instanceof VersionConflictError;
    }
    assertEquals(threw, true);
  },
});

Deno.test({
  name: "admin-version: adminVersionMiddleware 版本不匹配返回 409",
  fn: async () => {
    const app = new Hono();
    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(
          { error: err.message, code: err.code, ...(err.meta ?? {}) },
          err.statusCode as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
        );
      }
      return c.json({ error: "internal" }, 500);
    });
    app.patch(
      "/resource/:id",
      adminVersionMiddleware(() => Promise.resolve("current-version")),
      (c) => c.json({ ok: true }, 200),
    );
    const res = await app.request("http://localhost/resource/1", {
      method: "PATCH",
      headers: { "If-Match": "stale-version" },
    });
    assertEquals(res.status, 409);
    const body = await res.json();
    assertEquals(body.code, "VERSION_CONFLICT");
  },
});

Deno.test({
  name: "admin-version: 缺少 If-Match 时放行且不读取当前版本",
  fn: async () => {
    let getCurrentVersionCalled = false;
    const app = new Hono();
    app.patch(
      "/resource/:id",
      adminVersionMiddleware(() => {
        getCurrentVersionCalled = true;
        return Promise.resolve("current-version");
      }),
      (c) => c.json({ ok: true }, 200),
    );
    const res = await app.request("http://localhost/resource/1", {
      method: "PATCH",
    });
    assertEquals(res.status, 200);
    assertEquals(getCurrentVersionCalled, false);
  },
});
