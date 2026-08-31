import { assertEquals, assertRejects } from "@std/assert";
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

async function sha256Hex(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", input as BufferSource);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

Deno.test("resolveLatestVersion: 去掉前导 v 并返回 tag", async () => {
  try {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(String(url));
      return jsonResponse({ tag_name: "v0.2.0" });
    });
    const version = await resolveLatestVersion();
    assertEquals(version, "0.2.0");
    assertEquals(calls.length, 1);
    assertEquals(
      calls[0],
      "https://api.github.com/repos/Neuro-OJ/neuro-oj/releases/latest",
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

Deno.test("resolveLatestVersion: 缺少 tag_name 抛错", async () => {
  try {
    mockFetch(() => jsonResponse({}));
    await assertRejects(
      () => resolveLatestVersion(),
      Error,
      "缺少 tag_name",
    );
  } finally {
    restoreFetch();
  }
});

Deno.test("ensureNojServerBinary: 版本一致时复用已有二进制", async () => {
  const dir = await Deno.makeTempDir();
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
  const dir = await Deno.makeTempDir();
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
  const dir = await Deno.makeTempDir();
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
  const dir = await Deno.makeTempDir();
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
  const dir = await Deno.makeTempDir();
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
  const dir = await Deno.makeTempDir();
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
