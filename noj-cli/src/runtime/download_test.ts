import { makeTempDir } from "../testing/helpers.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { sha256Hex } from "../util/hash.ts";
import {
  DEFAULT_NOJ_SERVER_VERSION,
  ensureNojServerBinary,
  resolveLatestVersion,
} from "./download.ts";

/** 保存原始 fetch，测试后恢复。 */
const originalFetch = globalThis.fetch;

function mockFetch(
  handler: (url: string | URL | Request) => Response | Promise<Response>,
): void {
  globalThis.fetch = handler as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 构造一个资产就绪的稳定 Release 条目。 */
function readyRelease(tag: string): Record<string, unknown> {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [
      { name: "noj-cli-linux-amd64" },
      { name: "noj-cli-linux-amd64.sha256" },
    ],
  };
}

Deno.test("resolveLatestVersion: 去掉前导 v 并返回 tag", async () => {
  try {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(String(url));
      return jsonResponse([readyRelease("v0.2.0")]);
    });
    const version = await resolveLatestVersion();
    assertEquals(version, "0.2.0");
    assertEquals(calls.length, 1);
    assertEquals(
      calls[0],
      "https://api.github.com/repos/Neuro-OJ/neuro-oj/releases?per_page=100",
    );
  } finally {
    restoreFetch();
  }
});

Deno.test("resolveLatestVersion: 跳过预发布、草稿和缺少 CLI 资产的版本", async () => {
  try {
    mockFetch(() =>
      jsonResponse([
        { tag_name: "v0.3.0-rc.1", draft: false, prerelease: true, assets: [] },
        { tag_name: "v0.3.0", draft: true, prerelease: false, assets: [] },
        { tag_name: "v0.2.5", draft: false, prerelease: false, assets: [] },
        {
          tag_name: "v0.2.4",
          draft: false,
          prerelease: false,
          assets: [{ name: "noj-cli-linux-amd64" }],
        },
        readyRelease("v0.2.3"),
      ])
    );
    const version = await resolveLatestVersion();
    assertEquals(version, "0.2.3");
  } finally {
    restoreFetch();
  }
});

Deno.test("resolveLatestVersion: 没有资产就绪的正式 Release 时抛错", async () => {
  try {
    mockFetch(() =>
      jsonResponse([
        { tag_name: "v0.2.0", draft: false, prerelease: false, assets: [] },
        { tag_name: "v0.3.0-rc.1", draft: false, prerelease: true, assets: [] },
      ])
    );
    await assertRejects(
      () => resolveLatestVersion(),
      Error,
      "没有发现资产就绪的正式 Release",
    );
  } finally {
    restoreFetch();
  }
});

Deno.test("resolveLatestVersion: HTTP 非 2xx 抛错", async () => {
  try {
    mockFetch(() => jsonResponse({ message: "rate limit" }, 403));
    await assertRejects(
      () => resolveLatestVersion(),
      Error,
      "GitHub API 403",
    );
  } finally {
    restoreFetch();
  }
});

Deno.test("resolveLatestVersion: 响应不是 Release 列表时抛错", async () => {
  try {
    mockFetch(() => jsonResponse({ tag_name: "v0.2.0" }));
    await assertRejects(
      () => resolveLatestVersion(),
      Error,
      "响应不是 Release 列表",
    );
  } finally {
    restoreFetch();
  }
});

Deno.test("ensureNojServerBinary: 版本一致时复用已有二进制", async () => {
  const dir = await makeTempDir();
  try {
    await Deno.mkdir(`${dir}/bin`, { recursive: true });
    await Deno.writeTextFile(`${dir}/bin/noj-server`, "#!/bin/sh\n");
    await Deno.writeTextFile(`${dir}/bin/noj-server.version`, "0.1.0\n");
    let fetched = false;
    mockFetch(() => {
      fetched = true;
      return jsonResponse({});
    });
    const bin = await ensureNojServerBinary({
      installDir: dir,
      version: "0.1.0",
    });
    assertEquals(bin, `${dir}/bin/noj-server`);
    assertEquals(fetched, false);
  } finally {
    restoreFetch();
  }
});

Deno.test("ensureNojServerBinary: 已有二进制但无版本文件时不覆盖", async () => {
  const dir = await makeTempDir();
  try {
    await Deno.mkdir(`${dir}/bin`, { recursive: true });
    await Deno.writeTextFile(`${dir}/bin/noj-server`, "user-built\n");
    let fetched = false;
    mockFetch(() => {
      fetched = true;
      return jsonResponse({});
    });
    const bin = await ensureNojServerBinary({
      installDir: dir,
      version: "0.1.0",
    });
    assertEquals(bin, `${dir}/bin/noj-server`);
    assertEquals(fetched, false);
    assertEquals(
      await Deno.readTextFile(`${dir}/bin/noj-server`),
      "user-built\n",
    );
  } finally {
    restoreFetch();
  }
});

Deno.test("ensureNojServerBinary: 缺失时下载、校验并落盘", async () => {
  const dir = await makeTempDir();
  try {
    const bytes = new TextEncoder().encode("fake-noj-server-binary");
    const expected = await sha256Hex(bytes);
    const calls: string[] = [];
    mockFetch((url) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith(".sha256")) {
        return new Response(`${expected}  noj-server-linux-amd64\n`, {
          status: 200,
        });
      }
      return new Response(bytes, { status: 200 });
    });
    const bin = await ensureNojServerBinary({
      installDir: dir,
      version: "0.1.0",
      baseUrl: "https://example.test/releases/download",
    });
    assertEquals(bin, `${dir}/bin/noj-server`);
    assertEquals(
      new TextDecoder().decode(await Deno.readFile(bin)),
      "fake-noj-server-binary",
    );
    assertEquals(
      await Deno.readTextFile(`${dir}/bin/noj-server.version`),
      "0.1.0\n",
    );
    const stat = await Deno.stat(bin);
    assertEquals((stat.mode! & 0o111) !== 0, true);
    assertEquals(calls.length, 2);
    assertEquals(
      calls[0],
      "https://example.test/releases/download/0.1.0/noj-server-linux-amd64",
    );
    assertEquals(
      calls[1],
      "https://example.test/releases/download/0.1.0/noj-server-linux-amd64.sha256",
    );
  } finally {
    restoreFetch();
  }
});

Deno.test("ensureNojServerBinary: SHA-256 不匹配时抛错且不落盘", async () => {
  const dir = await makeTempDir();
  try {
    const bytes = new TextEncoder().encode("bad-binary");
    const expected = await sha256Hex(new TextEncoder().encode("good-binary"));
    mockFetch((url) => {
      const u = String(url);
      if (u.endsWith(".sha256")) {
        return new Response(`${expected}  noj-server-linux-amd64\n`, {
          status: 200,
        });
      }
      return new Response(bytes, { status: 200 });
    });
    await assertRejects(
      () =>
        ensureNojServerBinary({
          installDir: dir,
          version: "0.1.0",
          baseUrl: "https://example.test/releases/download",
        }),
      Error,
      "SHA-256 校验失败",
    );
    await assertRejects(() => Deno.stat(`${dir}/bin/noj-server`), Error);
    await assertRejects(
      () => Deno.stat(`${dir}/bin/noj-server.version`),
      Error,
    );
    // 临时文件应被清理
    const leftovers: string[] = [];
    for await (const entry of Deno.readDir(`${dir}/bin`)) {
      if (entry.name.startsWith(".noj-server-")) leftovers.push(entry.name);
    }
    assertEquals(leftovers, []);
  } finally {
    restoreFetch();
  }
});

Deno.test("ensureNojServerBinary: 校验文件格式非法时抛错", async () => {
  const dir = await makeTempDir();
  try {
    mockFetch((url) => {
      const u = String(url);
      if (u.endsWith(".sha256")) {
        return new Response("not-a-sha256\n", { status: 200 });
      }
      return new Response("binary", { status: 200 });
    });
    await assertRejects(
      () =>
        ensureNojServerBinary({
          installDir: dir,
          version: "0.1.0",
          baseUrl: "https://example.test/releases/download",
        }),
      Error,
      "校验文件格式非法",
    );
  } finally {
    restoreFetch();
  }
});

Deno.test("ensureNojServerBinary: 下载 HTTP 失败时抛错", async () => {
  const dir = await makeTempDir();
  try {
    mockFetch(() => new Response("not found", { status: 404 }));
    await assertRejects(
      () =>
        ensureNojServerBinary({
          installDir: dir,
          version: "0.1.0",
          baseUrl: "https://example.test/releases/download",
        }),
      Error,
      "HTTP 404",
    );
  } finally {
    restoreFetch();
  }
});

Deno.test("DEFAULT_NOJ_SERVER_VERSION: 非空且为 semver 形式", () => {
  assertEquals(/^\d+\.\d+\.\d+$/.test(DEFAULT_NOJ_SERVER_VERSION), true);
});
