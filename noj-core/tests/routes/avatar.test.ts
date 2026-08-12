/**
 * 用户头像路由测试（issue #229）。
 *
 * 覆盖：上传（png/jpeg/webp）、大小/类型/magic bytes 校验、替换清理、
 * 删除幂等、公开读取（Content-Type/缓存头）、无头像 404、未登录 401。
 *
 * multipart 请求不走 jsonRequest（其强制 JSON Content-Type），
 * 直接构造 `new Request()` + `app.fetch()`（与 helper 的 fetch 约定一致）。
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { resetDbForTest } from "../../src/db/connection.ts";
import { createUserToken, jsonRequest } from "../lib/helper.ts";
import { sameStorageObject } from "../../src/services/users.ts";
import { getStorageProvider } from "../../src/lib/storage/factory.ts";

if (!Deno.env.get("JWT_SECRET")) {
  Deno.env.set(
    "JWT_SECRET",
    "avatar-route-test-secret-at-least-32-characters",
  );
}
// 绕过 JWT 撤销检查（Redis），保持 PGlite-only 测试自包含
Deno.env.set("NOJ_BYPASS_JWT_REVOKE", "1");

const BASE = "/api/v1/users";

// 合法图片字节（仅 magic bytes 头，后端不做完整解码）
const PNG_BYTES = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
]);
const JPEG_BYTES = new Uint8Array([
  0xff,
  0xd8,
  0xff,
  0xe0,
  0x00,
  0x10,
  0x4a,
  0x46,
  0x49,
  0x46,
  0x00,
  0x01,
]);
const WEBP_BYTES = new TextEncoder().encode("RIFF\x00\x00\x00\x00WEBPVP8 ");
const TEXT_BYTES = new TextEncoder().encode("not-an-image");

function avatarForm(
  name: string,
  type: string,
  data: Uint8Array,
): FormData {
  const fd = new FormData();
  // .buffer cast：规避 Deno 2.x 下 Uint8Array<ArrayBufferLike> 与 BlobPart 的
  // 泛型不兼容（TS2322），行为等价
  fd.append("file", new File([data.buffer as ArrayBuffer], name, { type }));
  return fd;
}

async function uploadAvatar(
  app: ReturnType<typeof createApp>,
  token: string,
  fd: FormData,
): Promise<Response> {
  return await app.fetch(
    new Request(`http://localhost${BASE}/me/avatar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    }),
  );
}

/** 创建测试用户并返回 { token, userId } */
async function createUser(app: ReturnType<typeof createApp>): Promise<{
  token: string;
  userId: string;
}> {
  const token = await createUserToken("user");
  const me = await jsonRequest(app, "/api/v1/auth/me", { token });
  const userId = (await me.json()).data.id as string;
  return { token, userId };
}

await resetDbForTest();

Deno.test("avatar: 上传 png 成功并返回 noj-storage:// URL", async () => {
  await resetDbForTest();
  const app = createApp();
  const { token } = await createUser(app);

  const res = await uploadAvatar(
    app,
    token,
    avatarForm("a.png", "image/png", PNG_BYTES),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(
    typeof body.data.avatar_url,
    "string",
  );
  assertEquals(
    body.data.avatar_url.startsWith("noj-storage://"),
    true,
    "avatar_url 应为 noj-storage:// 前缀",
  );
});

Deno.test("avatar: 上传后可公开读取，Content-Type 与缓存头正确", async () => {
  await resetDbForTest();
  const app = createApp();
  const { token, userId } = await createUser(app);
  await uploadAvatar(app, token, avatarForm("a.png", "image/png", PNG_BYTES));

  const getRes = await app.fetch(
    new Request(`http://localhost${BASE}/${userId}/avatar`),
  );
  assertEquals(getRes.status, 200);
  assertEquals(getRes.headers.get("content-type"), "image/png");
  assertEquals(
    getRes.headers.get("cache-control"),
    "public, max-age=86400",
  );
  assertEquals(getRes.headers.has("etag"), true);
  // 字节应与上传一致
  const bytes = new Uint8Array(await getRes.arrayBuffer());
  assertEquals(bytes.length, PNG_BYTES.length);
});

Deno.test("avatar: 三种格式均支持（png/jpeg/webp）", async () => {
  await resetDbForTest();
  const app = createApp();
  const { token, userId } = await createUser(app);

  const cases: [string, string, Uint8Array, string][] = [
    ["a.png", "image/png", PNG_BYTES, "image/png"],
    ["b.jpg", "image/jpeg", JPEG_BYTES, "image/jpeg"],
    ["c.webp", "image/webp", WEBP_BYTES, "image/webp"],
  ];
  for (const [name, type, data, expectType] of cases) {
    const up = await uploadAvatar(app, token, avatarForm(name, type, data));
    assertEquals(up.status, 200, `上传 ${name} 应成功`);
    const getRes = await app.fetch(
      new Request(`http://localhost${BASE}/${userId}/avatar`),
    );
    assertEquals(
      getRes.headers.get("content-type"),
      expectType,
      `${name} 的 Content-Type 应正确`,
    );
  }
});

Deno.test("avatar: 超过 2MB 被拒", async () => {
  await resetDbForTest();
  const app = createApp();
  const { token } = await createUser(app);

  const big = new Uint8Array(2 * 1024 * 1024 + 1).fill(0x89);
  const res = await uploadAvatar(
    app,
    token,
    avatarForm("big.png", "image/png", big),
  );
  assertEquals(res.status, 400);
});

Deno.test("avatar: 非法类型（txt/svg）与伪造扩展名被拒", async () => {
  await resetDbForTest();
  const app = createApp();
  const { token } = await createUser(app);

  const badCases: [string, string, Uint8Array][] = [
    ["a.txt", "text/plain", TEXT_BYTES],
    ["a.svg", "image/svg+xml", TEXT_BYTES],
    ["fake.png", "image/png", TEXT_BYTES], // magic bytes 不符
    ["noext", "", PNG_BYTES], // 无扩展名
  ];
  for (const [name, type, data] of badCases) {
    const res = await uploadAvatar(app, token, avatarForm(name, type, data));
    assertEquals(res.status, 400, `应拒绝 ${name}`);
  }
});

Deno.test("avatar: 扩展名/Content-Type/magic 不一致被拒", async () => {
  await resetDbForTest();
  const app = createApp();
  const { token } = await createUser(app);

  const mismatchCases: [string, string, Uint8Array, string][] = [
    // 扩展名与内容不符：jpg 扩展名 + PNG 字节
    ["a.jpg", "image/jpeg", PNG_BYTES, "jpg 扩展名 + PNG 内容"],
    // Content-Type 与内容不符：png 扩展名/类型 + JPEG 字节
    ["a.png", "image/png", JPEG_BYTES, "png 声明 + JPEG 内容"],
    // Content-Type 与内容不符：png 扩展名 + jpeg 声明 + PNG 字节
    ["a.png", "image/jpeg", PNG_BYTES, "png 内容 + jpeg 声明"],
    // Content-Type 与内容不符：webp 扩展名/类型 + PNG 字节
    ["a.webp", "image/webp", PNG_BYTES, "webp 声明 + PNG 内容"],
  ];
  for (const [name, type, data, desc] of mismatchCases) {
    const res = await uploadAvatar(app, token, avatarForm(name, type, data));
    assertEquals(res.status, 400, `应拒绝 ${desc}`);
  }
});

Deno.test("avatar: sameStorageObject 以 key 判等（S3 固定 key 替换场景）", () => {
  // S3 固定 key：替换后新旧 URL 仅 checksum 不同 → 同一对象，不得误删
  const oldUrl = "noj-storage://s3/avatar/u-1.png?checksum_sha256=aaaa";
  const newUrl = "noj-storage://s3/avatar/u-1.png?checksum_sha256=bbbb";
  assertEquals(sameStorageObject(oldUrl, newUrl), true);
  // 扩展名变更 → key 不同 → 属于不同对象，可清理旧文件
  const jpgUrl = "noj-storage://s3/avatar/u-1.jpg?checksum_sha256=bbbb";
  assertEquals(sameStorageObject(oldUrl, jpgUrl), false);
  // local 内容寻址：不同内容 → 不同 key
  assertEquals(
    sameStorageObject(
      "noj-storage://local/abc123.png?checksum_sha256=aaaa",
      "noj-storage://local/abc456.png?checksum_sha256=bbbb",
    ),
    false,
  );
  // 同一 URL 自然为同一对象
  assertEquals(sameStorageObject(oldUrl, oldUrl), true);
});

Deno.test("avatar: 替换上传后旧文件被清理（local 存储断言）", async () => {
  await resetDbForTest();
  const app = createApp();
  const { token } = await createUser(app);

  const up1 = await uploadAvatar(
    app,
    token,
    avatarForm("a.png", "image/png", PNG_BYTES),
  );
  const url1 = (await up1.json()).data.avatar_url as string;

  const up2 = await uploadAvatar(
    app,
    token,
    avatarForm("b.jpg", "image/jpeg", JPEG_BYTES),
  );
  const url2 = (await up2.json()).data.avatar_url as string;
  assertEquals(url1 !== url2, true, "不同内容应产生不同存储 URL");

  // 旧文件应已被删除（get 抛 NotFound）
  const provider = await getStorageProvider();
  let oldGone = false;
  try {
    await provider.get(url1);
  } catch {
    oldGone = true;
  }
  assertEquals(oldGone, true, "替换后旧头像文件应被清理");

  // 新文件可读
  const newBytes = await provider.get(url2);
  assertEquals(newBytes.length, JPEG_BYTES.length);
});

Deno.test("avatar: 同图重复上传不误删旧文件", async () => {
  await resetDbForTest();
  const app = createApp();
  const { token } = await createUser(app);

  const up1 = await uploadAvatar(
    app,
    token,
    avatarForm("a.png", "image/png", PNG_BYTES),
  );
  const url1 = (await up1.json()).data.avatar_url as string;
  const up2 = await uploadAvatar(
    app,
    token,
    avatarForm("a.png", "image/png", PNG_BYTES),
  );
  const url2 = (await up2.json()).data.avatar_url as string;
  assertEquals(url1, url2, "同图内容寻址 URL 应相同");
  const provider = await getStorageProvider();
  const bytes = await provider.get(url1);
  assertEquals(bytes.length, PNG_BYTES.length, "同图文件应仍存在");
});

Deno.test("avatar: 删除幂等，删除后 GET 404", async () => {
  await resetDbForTest();
  const app = createApp();
  const { token, userId } = await createUser(app);
  await uploadAvatar(app, token, avatarForm("a.png", "image/png", PNG_BYTES));

  const del1 = await app.fetch(
    new Request(`http://localhost${BASE}/me/avatar`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  assertEquals(del1.status, 204);

  // 幂等：无头像再删仍 204
  const del2 = await app.fetch(
    new Request(`http://localhost${BASE}/me/avatar`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  assertEquals(del2.status, 204);

  const getRes = await app.fetch(
    new Request(`http://localhost${BASE}/${userId}/avatar`),
  );
  assertEquals(getRes.status, 404);
});

Deno.test("avatar: 无头像 GET 404", async () => {
  await resetDbForTest();
  const app = createApp();
  const { userId } = await createUser(app);
  const getRes = await app.fetch(
    new Request(`http://localhost${BASE}/${userId}/avatar`),
  );
  assertEquals(getRes.status, 404);
});

Deno.test("avatar: 未登录上传/删除返回 401", async () => {
  await resetDbForTest();
  const app = createApp();
  const up = await uploadAvatar(
    app,
    "",
    avatarForm("a.png", "image/png", PNG_BYTES),
  );
  assertEquals(up.status, 401);
  const del = await app.fetch(
    new Request(`http://localhost${BASE}/me/avatar`, { method: "DELETE" }),
  );
  assertEquals(del.status, 401);
});
