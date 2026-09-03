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
import {
  DeleteObjectCommand,
  PutObjectCommand,
} from "npm:@aws-sdk/client-s3@^3";
import type { S3Client } from "npm:@aws-sdk/client-s3@^3";
import { createApp } from "../../src/app.ts";
import { resetDbForTest } from "./../../src/shared/db/connection.ts";
import { createUserToken, jsonRequest } from "../lib/helper.ts";
import { sameStorageObject } from "../../src/domains/identity/index.ts";
import { S3StorageProvider } from "./../../src/domains/system/services/storage/s3.ts";
import {
  getStorageProvider,
  resetStorageProvider,
  setStorageProviderForTest,
} from "./../../src/domains/system/services/storage/factory.ts";

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

Deno.test("avatar: 两用户同图共享时，换头像不破坏他人引用（local）", async () => {
  await resetDbForTest();
  const app = createApp();
  const a = await createUser(app);
  const b = await createUser(app);

  // A、B 上传相同字节头像 → 内容寻址下共享同一存储对象
  const upA = await uploadAvatar(
    app,
    a.token,
    avatarForm("a.png", "image/png", PNG_BYTES),
  );
  const urlA = (await upA.json()).data.avatar_url as string;
  const upB = await uploadAvatar(
    app,
    b.token,
    avatarForm("a.png", "image/png", PNG_BYTES),
  );
  const urlB = (await upB.json()).data.avatar_url as string;
  assertEquals(urlA, urlB, "同图内容寻址 URL 应相同（共享同一对象）");

  // B 换成不同图片
  const upB2 = await uploadAvatar(
    app,
    b.token,
    avatarForm("b.jpg", "image/jpeg", JPEG_BYTES),
  );
  const urlB2 = (await upB2.json()).data.avatar_url as string;
  assertEquals(urlA !== urlB2, true, "不同内容应产生不同存储 URL");

  // A 的公开头像仍可读（共享文件未被 B 换头像删除）
  const getA = await app.fetch(
    new Request(`http://localhost${BASE}/${a.userId}/avatar`),
  );
  assertEquals(getA.status, 200, "B 换头像后 A 的头像应仍可读");
  const bytes = new Uint8Array(await getA.arrayBuffer());
  assertEquals(bytes.length, PNG_BYTES.length, "A 头像字节应与上传一致");

  // 存储层：共享的 PNG 文件仍在，B 的新文件可读
  const provider = await getStorageProvider();
  const sharedBytes = await provider.get(urlA);
  assertEquals(sharedBytes.length, PNG_BYTES.length, "共享 PNG 文件应仍存在");
  const newBytes = await provider.get(urlB2);
  assertEquals(newBytes.length, JPEG_BYTES.length, "B 新头像文件应可读");
});

Deno.test("avatar: 两用户同图共享时，删除头像不破坏他人引用（local）", async () => {
  await resetDbForTest();
  const app = createApp();
  const a = await createUser(app);
  const b = await createUser(app);

  // A、B 上传相同字节头像 → 共享同一存储对象
  await uploadAvatar(app, a.token, avatarForm("a.png", "image/png", PNG_BYTES));
  const upB = await uploadAvatar(
    app,
    b.token,
    avatarForm("a.png", "image/png", PNG_BYTES),
  );
  const urlB = (await upB.json()).data.avatar_url as string;

  // B 删除头像
  const del = await app.fetch(
    new Request(`http://localhost${BASE}/me/avatar`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${b.token}` },
    }),
  );
  assertEquals(del.status, 204);

  // B 的头像 404，A 的头像仍可读（共享文件未被 B 删除）
  const getB = await app.fetch(
    new Request(`http://localhost${BASE}/${b.userId}/avatar`),
  );
  assertEquals(getB.status, 404, "B 删除后自身头像应 404");
  const getA = await app.fetch(
    new Request(`http://localhost${BASE}/${a.userId}/avatar`),
  );
  assertEquals(getA.status, 200, "B 删除头像后 A 的头像应仍可读");

  // 存储层：共享文件仍在
  const provider = await getStorageProvider();
  const sharedBytes = await provider.get(urlB);
  assertEquals(sharedBytes.length, PNG_BYTES.length, "共享 PNG 文件应仍存在");
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

Deno.test("avatar: sameStorageObject provider 不同/脏数据边界", () => {
  // provider 不同（local vs s3）即使 key 相同也属于不同对象
  assertEquals(
    sameStorageObject(
      "noj-storage://local/avatar/u-1.png?checksum_sha256=aaaa",
      "noj-storage://s3/avatar/u-1.png?checksum_sha256=aaaa",
    ),
    false,
  );
  // 脏数据（非 noj-storage:// URL）短路返回 false，不抛错
  assertEquals(
    sameStorageObject("not-a-storage-url", "noj-storage://s3/avatar/u-1.png"),
    false,
  );
  assertEquals(
    sameStorageObject("not-a-storage-url", "also-not-a-url"),
    false,
  );
});

/** 内存 fake S3 client：记录 send 的 command，不发起真实网络请求 */
class FakeS3Client {
  sent: unknown[] = [];
  send(command: unknown): Promise<unknown> {
    this.sent.push(command);
    return Promise.resolve({});
  }
}

Deno.test("avatar: S3 固定 key 同 key 替换不误删、换 key 清理旧对象", async () => {
  await resetDbForTest();
  const fake = new FakeS3Client();
  setStorageProviderForTest(
    new S3StorageProvider(
      {
        endpoint: "http://minio.test:9000",
        region: "us-east-1",
        accessKeyId: "test-key",
        secretAccessKey: "test-secret",
        bucket: "noj-avatars",
        forcePathStyle: true,
      },
      fake as unknown as S3Client,
    ),
  );
  try {
    const app = createApp();
    const { token, userId } = await createUser(app);

    // 1. 上传 PNG-A：固定 key avatar/{userId}.png
    const up1 = await uploadAvatar(
      app,
      token,
      avatarForm("a.png", "image/png", PNG_BYTES),
    );
    assertEquals(up1.status, 200);
    const url1 = (await up1.json()).data.avatar_url as string;
    assertEquals(url1.startsWith("noj-storage://s3/"), true);

    // 2. 同 key 替换（内容不同 → checksum 不同，key 不变）
    const pngB = new Uint8Array([...PNG_BYTES, 0x01]);
    const up2 = await uploadAvatar(
      app,
      token,
      avatarForm("b.png", "image/png", pngB),
    );
    assertEquals(up2.status, 200);
    const url2 = (await up2.json()).data.avatar_url as string;
    assertEquals(
      sameStorageObject(url1, url2),
      true,
      "S3 固定 key 下同 key 仅 checksum 不同 → 同一对象",
    );
    const puts = fake.sent.filter((c) => c instanceof PutObjectCommand);
    assertEquals(puts.length, 2, "两次上传应各 put 一次");
    assertEquals(
      fake.sent.filter((c) => c instanceof DeleteObjectCommand).length,
      0,
      "同 key 替换不得调用 delete（不得误删刚写入的新对象）",
    );

    // 3. 扩展名变更（jpg）→ key 变化 → 清理旧对象
    const up3 = await uploadAvatar(
      app,
      token,
      avatarForm("c.jpg", "image/jpeg", JPEG_BYTES),
    );
    assertEquals(up3.status, 200);
    const url3 = (await up3.json()).data.avatar_url as string;
    assertEquals(sameStorageObject(url2, url3), false, "扩展名变更 → 不同 key");

    const deletes = fake.sent.filter((c) => c instanceof DeleteObjectCommand);
    assertEquals(deletes.length, 1, "换 key 应删除旧对象");
    const delCmd = deletes[0] as DeleteObjectCommand;
    assertEquals(
      (delCmd as { input?: { Key?: string } }).input?.Key,
      `avatar/${userId}.png`,
      "删除的应是旧 key",
    );
  } finally {
    resetStorageProvider();
  }
});
