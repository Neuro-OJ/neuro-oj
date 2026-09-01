# 用户头像上传（#229）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为用户系统增加头像：`users.avatar_url` 字段、上传/删除/展示端点、全站 `UserIdentity` 组件接入与默认 SVG 占位。

**Architecture:** 方案 A——DB 存 `noj-storage://` URL（复用 StorageProvider），新增 `POST/DELETE /api/v1/users/me/avatar` 与公开 `GET /api/v1/users/:id/avatar`（core 代理返回字节流，与支持包下载同构）；前端封装 `UserIdentity` 组件统一头像+用户名展示，无头像时渲染本地生成的首字母 SVG 占位；Nitro 代理增加图片二进制透传分支。

**Tech Stack:** Deno + Hono + Drizzle（noj-core）；Nuxt 4 + Vue 3（noj-ui）；Rust/Docker 评测栈不涉及。

## Global Constraints

- 提交用 **jj**（`jj describe -m "<msg>"`），消息遵循 Conventional Commits、description 中文；每个新任务开始前先 `jj new`（除非工作副本 commit 为空）。
- GPG 签名已配置（`jj config get signing.key` = F2228B68...），提交自动签名，无需额外操作。
- 头像限制：**≤2MB**、类型 **png/jpeg/webp**，**拒绝 SVG**（XSS）。
- 扩展名规范化：`image/jpeg → jpg`（存储统一 jpg）。
- 存储 key 格式：`<base64url-hash>.<ext>`；旧无扩展名 key 按 `.zip` 兼容。
- 中文注释 + 英文标识符；后端错误用 `AppError` 继承体系（`BadRequestError`）。
- noj-core 测试命令：`deno task test`（PGlite 内存库）；单文件：`env -u DATABASE_URL deno test -A --no-check <file>`。
- noj-ui 验证：`deno task lint` / `deno task fmt` / `nuxt build`（构建为 `deno task build`，见 noj-ui/deno.json 实际任务名）。
- 路由注册顺序：`/me/*` 必须在 `/:id/*` 之前（避免 "me" 被匹配为 `:id`）。
- 设计文档：`dev-docs/superpowers/specs/2026-08-12-avatar-profile-design.md`（本计划唯一事实来源，冲突时以设计文档为准）。

---

### Task 1: 数据层——`users.avatar_url` 字段 + Drizzle 迁移

**Files:**
- Modify: `noj-core/src/db/schema.ts:36-72`（users 表）
- Create: `noj-core/drizzle/0038_*.sql`（db:generate 自动生成）
- Test: `noj-core/tests/00_migrate_test.ts`（既有迁移测试，无需新增文件）

**Interfaces:**
- Produces: `users.avatar_url: text` 可空列；DB 中存 `noj-storage://` URL 或 NULL。

- [ ] **Step 1: 在 schema.ts 的 users 表加字段**

在 `community_activity_visibility` 与 `created_at` 之间（`updated_at` 之前）加入：

```ts
    /** 用户头像存储 URL（`noj-storage://` 格式），NULL = 未设置 */
    avatar_url: text("avatar_url"),
```

- [ ] **Step 2: 生成迁移**

Run: `cd noj-core && deno task db:generate`
Expected: 生成 `drizzle/0038_*.sql`，内容为 `ALTER TABLE "users" ADD COLUMN "avatar_url" text;`（不带 schema 前缀，参考 AGENTS.md §12.1 历史陷阱）。

- [ ] **Step 3: 跑迁移测试确认可应用**

Run: `cd noj-core && deno task test`
Expected: `00_migrate_test.ts` 迁移到 0038 成功，全量测试通过（旧测试不受影响）。

- [ ] **Step 4: 提交**

```bash
jj describe -m "feat(core): users 表新增 avatar_url 字段（#229）"
```

---

### Task 2: 存储层——LocalStorageProvider 扩展名泛化（TDD）

**Files:**
- Modify: `noj-core/src/lib/storage/local.ts`
- Test: `noj-core/tests/lib/storage/local-storage.test.ts`

**Interfaces:**
- Consumes: `StorageProvider.put(key, data, contentType?)`（`lib/storage/types.ts`，接口不变）
- Produces: `put()` 返回的 URL key 形如 `<base64url-hash>.<ext>`（png/jpg/webp）；`get()`/`delete()` 对无扩展名 key 回退 `.zip`。

- [ ] **Step 1: 写失败测试（追加到 local-storage.test.ts）**

```ts
Deno.test("LocalStorageProvider: image/png 存为 .png 并读回", async () => {
  const provider = new LocalStorageProvider();
  const data = new TextEncoder().encode("fake-png-bytes");
  const url = await provider.put("avatar-key", data, "image/png");

  const key = url.split("?")[0].replace("noj-storage://local/", "");
  assertEquals(key.endsWith(".png"), true, "key 应带 .png 扩展名");
  const readBack = await provider.get(url);
  assertEquals(readBack, data);
});

Deno.test("LocalStorageProvider: 未知 contentType 回退 .zip", async () => {
  const provider = new LocalStorageProvider();
  const url = await provider.put("k", new TextEncoder().encode("x"), "application/octet-stream");
  const key = url.split("?")[0].replace("noj-storage://local/", "");
  assertEquals(key.endsWith(".zip"), true);
});

Deno.test("LocalStorageProvider: 无扩展名旧 URL 仍按 .zip 读取", async () => {
  const provider = new LocalStorageProvider();
  const url = await provider.put("k", new TextEncoder().encode("zip-content"), "application/zip");
  // 模拟旧格式：剥离扩展名构造 URL（key 无扩展名）
  const key = url.split("?")[0].replace("noj-storage://local/", "");
  const bareKey = key.replace(/\.zip$/, "");
  const legacyUrl = `noj-storage://local/${bareKey}`;
  const readBack = await provider.get(legacyUrl);
  assertEquals(new TextDecoder().decode(readBack), "zip-content");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd noj-core && env -u DATABASE_URL deno test -A --no-check tests/lib/storage/local-storage.test.ts`
Expected: 第一个测试 FAIL（`key.endsWith(".png")` 为 false，当前实现总是 `.zip`）。

- [ ] **Step 3: 实现扩展名支持**

在 `local.ts` 顶部加入常量与辅助函数，并改造 `put`/`get`/`delete`：

```ts
/** contentType → 扩展名映射（未知回退 .zip，保持支持包兼容） */
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** 已知图片/zip 扩展名集合（用于 get/delete 的 key 解析） */
const KNOWN_EXTS = /\.(png|jpe?g|webp|zip)$/i;

/** 根据 contentType 推导文件扩展名 */
function extensionFor(contentType?: string): string {
  return (contentType && EXT_BY_CONTENT_TYPE[contentType]) ?? "zip";
}

/** key → 磁盘文件路径：带已知扩展名直接用，否则回退 .zip（兼容旧支持包 URL） */
function filePathFor(storageDir: string, key: string): string {
  const suffix = KNOWN_EXTS.test(key) ? "" : ".zip";
  return `${storageDir}/${key}${suffix}`;
}
```

`put` 中把两处拼接改为：

```ts
    const base64Key = this.hexToBase64url(hashHex);
    const ext = extensionFor(contentType);
    const fileName = `${base64Key}.${ext}`;
    const filePath = `${this.storageDir}/${fileName}`;
```

`get` 中：

```ts
    const filePath = filePathFor(this.storageDir, parsed.key);
```

`delete` 中：

```ts
    const filePath = filePathFor(this.storageDir, parsed.key);
```

（注意：`put` 的签名已是 `put(key, data, contentType?)`，`_contentType` 参数改名为 `contentType` 使用。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd noj-core && env -u DATABASE_URL deno test -A --no-check tests/lib/storage/local-storage.test.ts`
Expected: 全部 PASS（含既有 zip 测试，行为不变）。

- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(core): LocalStorageProvider 支持图片扩展名存储（#229）"
```

---

### Task 3: 后端——头像 service + 上传/删除/展示端点（TDD）

**Files:**
- Modify: `noj-core/src/services/users.ts`（新增头像逻辑）
- Modify: `noj-core/src/routes/users.ts`（新增 3 个端点）
- Create: `noj-core/tests/routes/avatar.test.ts`
- Modify: `noj-core/tests/lib/helper.ts`（如需 multipart 辅助，见 Step 1）

**Interfaces:**
- Consumes: `getStorageProvider()`（`lib/storage/factory.ts`）；`authMiddleware`（`middleware/auth.ts`）；`AppError`（`lib/errors.ts`）；`users.avatar_url` 列（Task 1）
- Produces:
  - `updateUserAvatar(userId: string, file: File): Promise<{ avatar_url: string | null }>`
  - `clearUserAvatar(userId: string): Promise<{ avatar_url: null }>`
  - `getUserAvatarBytes(userId: string): Promise<{ bytes: Uint8Array; contentType: string; etag: string }>`（无头像抛 `NotFoundError`）
  - `POST /api/v1/users/me/avatar`、`DELETE /api/v1/users/me/avatar`、`GET /api/v1/users/:id/avatar`（公开）

- [ ] **Step 1: 写失败测试（新建 tests/routes/avatar.test.ts）**

参考 `tests/routes/auth.test.ts` 的 app 构造与 `jsonRequest` 用法；multipart 上传用原生 `app.request` + `FormData`。测试骨架（登录用户取 token 的方式与 auth.test.ts 一致）：

```ts
import { app } from "../../src/app.ts";
import { jsonRequest } from "../lib/helper.ts";

// 与 auth.test.ts 相同的注册/登录辅助（复制其 getToken 逻辑）
async function registerAndGetToken(): Promise<string> { /* ...注册+登录，返回 token... */ }

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const WEBP_BYTES = new TextEncoder().encode("RIFF\x00\x00\x00\x00WEBPVP8 ");
const TEXT_BYTES = new TextEncoder().encode("not-an-image");

function avatarForm(name: string, type: string, data: Uint8Array): FormData {
  const fd = new FormData();
  fd.append("file", new File([data], name, { type }));
  return fd;
}

Deno.test("avatar: 上传 png 成功并返回 avatar_url", async () => {
  const token = await registerAndGetToken();
  const fd = avatarForm("a.png", "image/png", PNG_BYTES);
  const res = await app.request("/api/v1/users/me/avatar", {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd,
  });
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.data.avatar_url.startsWith("noj-storage://"), true);
});

Deno.test("avatar: 上传后可公开读取，Content-Type 正确", async () => {
  const token = await registerAndGetToken();
  await app.request("/api/v1/users/me/avatar", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: avatarForm("a.png", "image/png", PNG_BYTES) });
  // 用注册用户 id 请求 GET（token 解码或注册接口返回 user id）
  const getRes = await app.request(`/api/v1/users/${userId}/avatar`);
  assertEquals(getRes.status, 200);
  assertEquals(getRes.headers.get("content-type"), "image/png");
  assertEquals(getRes.headers.get("cache-control"), "public, max-age=86400");
});

Deno.test("avatar: 超过 2MB 被拒", async () => {
  const token = await registerAndGetToken();
  const big = new Uint8Array(2 * 1024 * 1024 + 1).fill(0x89);
  const fd = avatarForm("big.png", "image/png", big);
  const res = await app.request("/api/v1/users/me/avatar", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
  assertEquals(res.status, 400);
});

Deno.test("avatar: 非法类型（txt/svg）与伪造扩展名被拒", async () => {
  const token = await registerAndGetToken();
  for (const fd of [
    avatarForm("a.txt", "text/plain", TEXT_BYTES),
    avatarForm("a.svg", "image/svg+xml", TEXT_BYTES),
    avatarForm("fake.png", "image/png", TEXT_BYTES), // magic bytes 不符
  ]) {
    const res = await app.request("/api/v1/users/me/avatar", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
    assertEquals(res.status, 400, "应拒绝: " + fd.get("file")?.name);
  }
});

Deno.test("avatar: 替换上传后旧文件清理（local 模式断言存储目录）", async () => {
  // 上传 PNG → 上传 JPEG → 断言存储目录只剩 .jpg 文件（含 .png 的旧文件被删除）
});

Deno.test("avatar: 删除幂等，删除后 GET 404", async () => {
  const token = await registerAndGetToken();
  await app.request("/api/v1/users/me/avatar", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: avatarForm("a.png", "image/png", PNG_BYTES) });
  const del1 = await app.request("/api/v1/users/me/avatar", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  assertEquals(del1.status, 204);
  const del2 = await app.request("/api/v1/users/me/avatar", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  assertEquals(del2.status, 204); // 幂等
  const getRes = await app.request(`/api/v1/users/${userId}/avatar`);
  assertEquals(getRes.status, 404);
});

Deno.test("avatar: 无头像 GET 404", async () => {
  const token = await registerAndGetToken();
  const getRes = await app.request(`/api/v1/users/${userId}/avatar`);
  assertEquals(getRes.status, 404);
});
```

（`userId` 从注册响应或 JWT 获取，沿用 auth.test.ts 既有做法；`jsonRequest` 对 GET/DELETE JSON 端点够用，multipart 必须用 `app.request`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd noj-core && env -u DATABASE_URL deno test -A --no-check tests/routes/avatar.test.ts`
Expected: FAIL（404/405——端点不存在）。

- [ ] **Step 3: 实现 service（services/users.ts 追加）**

```ts
/** 头像大小上限（2MB） */
export const MAX_AVATAR_SIZE = 2 * 1024 * 1024;
/** 允许的头像 MIME 类型 */
const AVATAR_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
/** 允许的头像扩展名（jpeg 与 jpg 均接受） */
const AVATAR_EXT = /\.(png|jpe?g|webp)$/i;

/** 校验头像文件，返回字节（校验链：扩展名 → Content-Type → 大小 → magic bytes） */
async function validateAvatarFile(file: File): Promise<Uint8Array> {
  if (!AVATAR_EXT.test(file.name)) {
    throw new BadRequestError("仅支持 png/jpeg/webp 图片");
  }
  if (file.type && !AVATAR_MIME.has(file.type)) {
    throw new BadRequestError("仅支持 png/jpeg/webp 图片");
  }
  if (file.size > MAX_AVATAR_SIZE) {
    throw new BadRequestError("头像大小超过限制（最大 2MB）");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  const isWebp = bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  if (!(isPng || isJpeg || isWebp)) {
    throw new BadRequestError("文件不是有效的图片");
  }
  return bytes;
}

/** 上传/替换头像：存储 → 更新 DB → 清理旧文件 */
export async function updateUserAvatar(
  userId: string,
  file: File,
): Promise<{ avatar_url: string | null }> {
  const bytes = await validateAvatarFile(file);
  const provider = await getStorageProvider();
  // 1. 先存新文件
  const newUrl = await provider.put(`avatar/${userId}`, bytes, file.type);
  const db = getDb();
  // 2. 更新 DB（拿旧 URL 用于清理）
  const old = await db.select({ avatar_url: users.avatar_url }).from(users)
    .where(eq(users.id, userId)).limit(1);
  await db.update(users).set({ avatar_url: newUrl, updated_at: new Date().toISOString() })
    .where(eq(users.id, userId));
  // 3. 清理旧文件（内容寻址：同图 URL 相同不误删）
  const oldUrl = old[0]?.avatar_url;
  if (oldUrl && oldUrl !== newUrl) {
    try { await provider.delete(oldUrl); } catch { /* 幂等忽略 */ }
  }
  return { avatar_url: newUrl };
}

/** 删除头像：清空字段 + 删除文件（幂等） */
export async function clearUserAvatar(userId: string): Promise<{ avatar_url: null }> {
  const db = getDb();
  const old = await db.select({ avatar_url: users.avatar_url }).from(users)
    .where(eq(users.id, userId)).limit(1);
  await db.update(users).set({ avatar_url: null, updated_at: new Date().toISOString() })
    .where(eq(users.id, userId));
  const oldUrl = old[0]?.avatar_url;
  if (oldUrl) {
    const provider = await getStorageProvider();
    try { await provider.delete(oldUrl); } catch { /* 幂等忽略 */ }
  }
  return { avatar_url: null };
}

/** 读取头像字节（无头像抛 NotFoundError） */
export async function getUserAvatarBytes(
  userId: string,
): Promise<{ bytes: Uint8Array; contentType: string; etag: string }> {
  const db = getDb();
  const row = await db.select({ avatar_url: users.avatar_url }).from(users)
    .where(eq(users.id, userId)).limit(1);
  const url = row[0]?.avatar_url;
  if (!url) throw new NotFoundError("该用户未设置头像");
  const provider = await getStorageProvider();
  const bytes = await provider.get(url);
  const parsed = parseStorageUrl(url);
  const contentType = /\.png$/i.test(parsed.key) ? "image/png"
    : /\.webp$/i.test(parsed.key) ? "image/webp"
    : "image/jpeg";
  return { bytes, contentType, etag: parsed.checksumSha256 ?? `"${parsed.key}"` };
}
```

（顶部 import 补 `getStorageProvider`、`parseStorageUrl`；`updated_at` 更新与现有 updateUserProfile 风格一致，可先查现状是否更新该列——如现有一致则保留。）

- [ ] **Step 4: 实现路由（routes/users.ts，放在 `/search` 与 `PUT /me` 之后、`GET /:id/profile` 之前）**

```ts
/**
 * 上传/替换当前用户头像。
 * POST /api/v1/users/me/avatar
 * multipart `file` 字段；校验 png/jpeg/webp、≤2MB、magic bytes。
 */
users.post("/me/avatar", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || !(file instanceof File)) {
    throw new BadRequestError("请上传有效的图片文件");
  }
  const result = await updateUserAvatar(userId, file);
  return c.json({ data: result }, 200);
});

/**
 * 删除当前用户头像（幂等）。
 * DELETE /api/v1/users/me/avatar
 */
users.delete("/me/avatar", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  await clearUserAvatar(userId);
  return c.body(null, 204);
});

/**
 * 获取用户头像（公开）。
 * GET /api/v1/users/:id/avatar
 * 无头像 → 404；有 → 图片字节流 + 缓存头（ETag = 内容 checksum）。
 */
users.get("/:id/avatar", async (c) => {
  const userId = c.req.param("id") as string;
  const { bytes, contentType, etag } = await getUserAvatarBytes(userId);
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
      "ETag": etag,
    },
  });
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd noj-core && env -u DATABASE_URL deno test -A --no-check tests/routes/avatar.test.ts`
Expected: 全部 PASS；随后 `deno task test` 确认无回归。

- [ ] **Step 6: 提交**

```bash
jj describe -m "feat(core): 用户头像上传/删除/展示端点（#229）"
```

---

### Task 4: 后端——全站响应补充 avatar_url（TDD）

**Files:**
- Modify: `noj-core/src/types/auth.ts:42-55`（UserResponse）
- Modify: `noj-core/src/services/users.ts`（getUserProfile / getUserProfileAggregate）
- Modify: `noj-core/src/services/community.ts`（8 处 `author: { id, username }` 选择）
- Modify: `noj-core/src/services/messages.ts:239`（私信联系人）
- Modify: `noj-core/src/services/search.ts`（用户/社区搜索结果的 username 选择）
- Modify: `noj-core/src/services/contests.ts:504`（竞赛答疑 author）
- Modify: `noj-core/src/routes/admin.ts`（admin 用户列表，若返回 username）
- Test: 追加断言到 `tests/routes/community.test.ts`、`tests/routes/messages.test.ts`、`tests/routes/search.test.ts`、`tests/routes/auth.test.ts`

**Interfaces:**
- Consumes: `users.avatar_url`（Task 1）
- Produces: 所有含用户信息的响应对象带 `avatar_url: string | null`。

- [ ] **Step 1: 写失败测试（在既有测试文件追加断言）**

在 `tests/routes/auth.test.ts` 的 `/me` 用例中追加：

```ts
    assertEquals(user.avatar_url, null); // 新注册用户无头像
```

在 `tests/routes/community.test.ts` 帖子列表用例中追加：

```ts
    const post = data.data[0];
    assertEquals(typeof post.author.avatar_url, "string");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd noj-core && env -u DATABASE_URL deno test -A --no-check tests/routes/auth.test.ts tests/routes/community.test.ts`
Expected: FAIL（avatar_url 为 undefined）。

- [ ] **Step 3: 实现字段补充**

`types/auth.ts` UserResponse 加：

```ts
  /** 用户头像存储 URL（`noj-storage://`），null = 未设置 */
  avatar_url: string | null;
```

`services/users.ts` 中所有 `db.select({...users 字段...})` 处加 `avatar_url: users.avatar_url`（getUserProfile、getUserProfileAggregate 的 user 子对象）。

`services/community.ts` 全部 8 处 `author: { id: users.id, username: users.username }` 改为：

```ts
    author: {
      id: users.id,
      username: users.username,
      avatar_url: users.avatar_url,
    },
```

（含 `actor:` 那处 1288 行。）

`services/messages.ts:239` 联系人选择加 `avatar_url: users.avatar_url`；下游 `userMap` 与联系人返回对象同步透传（若存在映射则同样在返回结构加字段）。

`services/search.ts`：用户搜索结果（274-291 行附近）与社区结果（`author_username` 处）补 `avatar_url: users.avatar_url`（社区结果的 author 对象若只含 username 文本，则保持文本并另加 `author_avatar_url`——以现有返回结构为准，选择最小改动）。

`services/contests.ts:504` 答疑用户选择加 `avatar_url: users.avatar_url`。

`routes/admin.ts` 用户列表（若含 username）补 `avatar_url`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd noj-core && env -u DATABASE_URL deno test -A --no-check tests/routes/auth.test.ts tests/routes/community.test.ts tests/routes/messages.test.ts tests/routes/search.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(core): 全站用户响应补充 avatar_url 字段（#229）"
```

---

### Task 5: 前端——Nitro 代理图片二进制透传

**Files:**
- Modify: `noj-ui/server/api/[...slug].ts`

**Interfaces:**
- Consumes: `GET /api/v1/users/:id/avatar`（Task 3）
- Produces: 经代理的图片请求返回原始字节流 + `Content-Type` / `ETag` / `Cache-Control`，JSON 分支行为不变。

- [ ] **Step 1: 实现透传分支**

在 `[...slug].ts` 的转发 `try` 块中，`$fetch.raw` 之后、JSON `return data` 之前插入：

```ts
      // 图片端点（头像）二进制透传：ofetch 默认按 JSON 解析会破坏字节流
      const contentType = (response.headers.get("content-type") ?? "").split(";")[0];
      if (contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp") {
        const buf = await response.arrayBuffer();
        const headers = new Headers();
        for (const name of ["content-type", "etag", "cache-control"]) {
          const value = response.headers.get(name);
          if (value) headers.set(name, value);
        }
        setResponseStatus(event, response.status);
        return new Response(buf, { headers });
      }
```

（`$fetch.raw` 的 `response.headers` 为 Headers 实例，`.get()` 可用。）

- [ ] **Step 2: 验证 JSON 分支无回归 + 图片分支工作**

Run: `cd noj-ui && deno task lint`（或实际 lint 任务名），再启动 `noj-core`（`deno task dev`）与 `noj-ui`（`deno task dev`），手动验证：

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://localhost:3000/api/v1/users/<无头像用户id>/avatar
# 期望: 404（无头像 → 组件占位路径）
# 上传头像后再次请求，期望: 200 image/png 且字节可正常解码为图片
```

Expected: JSON 接口（如 `/api/v1/health`）行为不变；图片接口返回正确 Content-Type。

- [ ] **Step 3: 提交**

```bash
jj describe -m "feat(ui): Nitro 代理支持头像图片二进制透传（#229）"
```

---

### Task 6: 前端——UserIdentity 组件

**Files:**
- Create: `noj-ui/components/shared/UserIdentity.vue`

**Interfaces:**
- Consumes: 任意 `{ id, username, avatar_url? }` 形状的用户对象（Task 4 后各 API 响应已带 `avatar_url`）
- Produces: 组件 `UserIdentity`；props：`user`（必填）、`showUsername`（默认 true）、`showAvatar`（默认 true）、`size`（'sm'|'md'|'lg'，默认 'md'）、`link`（默认 true）、`to`（可选覆盖跳转目标）

- [ ] **Step 1: 创建组件（完整实现）**

```vue
<template>
    <component
        :is="link ? 'NuxtLink' : 'span'"
        :to="link ? (to ?? `/users/${user.id}`) : undefined"
        class="inline-flex items-center gap-2 no-underline"
        :class="{ 'cursor-pointer hover:opacity-80': link }"
    >
        <span
            v-if="showAvatar"
            class="relative inline-block shrink-0 rounded-full overflow-hidden"
            :style="{ width: `${sizePx}px`, height: `${sizePx}px` }"
        >
            <img
                v-if="user.avatar_url && !imgFailed"
                :src="`/api/v1/users/${user.id}/avatar`"
                :alt="user.username"
                class="size-full object-cover"
                loading="lazy"
                @error="imgFailed = true"
            />
            <svg v-else viewBox="0 0 40 40" class="size-full" :style="{ backgroundColor: bgColor }" aria-hidden="true">
                <text
                    x="50%" y="54%" text-anchor="middle" dominant-baseline="middle"
                    :fill="fgColor" font-size="18" font-weight="600"
                >{{ initial }}</text>
            </svg>
        </span>
        <span v-if="showUsername" class="truncate text-sm text-text-secondary">{{ user.username }}</span>
    </component>
</template>

<script setup lang="ts">
interface IdentityUser {
    id: string;
    username: string;
    avatar_url?: string | null;
}

const props = withDefaults(defineProps<{
    user: IdentityUser;
    showUsername?: boolean;
    showAvatar?: boolean;
    size?: 'sm' | 'md' | 'lg';
    link?: boolean;
    to?: string;
}>(), {
    showUsername: true,
    showAvatar: true,
    size: 'md',
    link: true,
});

// 图片加载失败 → 兜底切回首字母占位
const imgFailed = ref(false);
watch(() => props.user.avatar_url, () => { imgFailed.value = false; });

const SIZE_MAP = { sm: 24, md: 32, lg: 64 } as const;
const sizePx = computed(() => SIZE_MAP[props.size]);

// 首字母（中文用户名取首个字符，其他取大写首字母）
const initial = computed(() => {
    const name = props.user.username ?? "?";
    return name.charAt(0).toUpperCase();
});

// 按 username 哈希稳定配色（同一用户全站一致）
const hue = computed(() => {
    const name = props.user.username ?? "";
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
});
const bgColor = computed(() => `hsl(${hue.value} 60% 45%)`);
const fgColor = computed(() => `hsl(${hue.value} 60% 95%)`);
</script>
```

- [ ] **Step 2: 验证构建**

Run: `cd noj-ui && deno task lint && deno task fmt && deno task build`
Expected: lint/fmt/build 通过（Vue SFC 语法正确）。

- [ ] **Step 3: 提交**

```bash
jj describe -m "feat(ui): 新增 UserIdentity 头像用户名统一组件（#229）"
```

---

### Task 7: 前端——设置页头像区块 + useAuth 类型

**Files:**
- Modify: `noj-ui/composables/useAuth.ts`（UserResponse 类型加 `avatar_url`）
- Modify: `noj-ui/pages/settings.vue`（头像区块）

**Interfaces:**
- Consumes: `UserIdentity`（Task 6）；`POST/DELETE /api/v1/users/me/avatar`（Task 3）
- Produces: 上传/删除成功后 `useAuth().user.value.avatar_url` 同步更新；页面预览带时间戳参数破缓存。

- [ ] **Step 1: useAuth 类型加字段**

`noj-ui/composables/useAuth.ts` 的 `UserResponse` interface 加：

```ts
  avatar_url?: string | null;
```

（`sessionToUser` 的 SessionData 不含该字段，保持 `avatar_url: undefined`——组件对 `undefined` 走占位分支，行为正确。）

- [ ] **Step 2: settings.vue 加头像区块（在 bio 表单之前）**

在 `<script setup>` 中：

```ts
const avatarUploading = ref(false);
const avatarInput = ref<HTMLInputElement | null>(null);
const avatarPreviewKey = ref(Date.now()); // 上传后破缓存

// 上传头像（前端预校验类型/大小，与后端阈值一致）
async function handleAvatarUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (!/\.(png|jpe?g|webp)$/i.test(file.name) || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    toast.error("仅支持 png/jpeg/webp 图片");
    input.value = "";
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    toast.error("头像大小超过限制（最大 2MB）");
    input.value = "";
    return;
  }
  avatarUploading.value = true;
  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await api.post<{ data: { avatar_url: string } }>("/api/v1/users/me/avatar", fd);
    if (user.value) user.value.avatar_url = res.data.avatar_url;
    avatarPreviewKey.value = Date.now();
    toast.success("头像已更新");
  } finally {
    avatarUploading.value = false;
    input.value = "";
  }
}

// 删除头像（弹确认框）
async function handleAvatarDelete() {
  const ok = await dialog.confirm("确定删除头像吗？将恢复为默认头像。");
  if (!ok) return;
  await api.delete("/api/v1/users/me/avatar");
  if (user.value) user.value.avatar_url = null;
  avatarPreviewKey.value = Date.now();
  toast.success("头像已删除");
}
```

模板中（bio 区块前）：

```vue
<section class="flex items-center gap-6">
    <span v-if="user" class="inline-block rounded-full overflow-hidden" :style="{ width: '64px', height: '64px' }">
        <img
            v-if="user.avatar_url"
            :src="`/api/v1/users/${user.id}/avatar?t=${avatarPreviewKey}`"
            alt="当前头像" class="size-full object-cover"
        />
        <div v-else class="size-full flex items-center justify-center bg-primary-hover-bg text-text-secondary text-xl font-semibold">
            {{ (user.username || "?").charAt(0).toUpperCase() }}
        </div>
    </span>
    <div class="flex flex-col gap-2">
        <div class="flex items-center gap-3">
            <UButton color="primary" variant="outline" :loading="avatarUploading" @click="avatarInput?.click()">
                上传头像
            </UButton>
            <UButton v-if="user?.avatar_url" color="error" variant="outline" @click="handleAvatarDelete">
                删除头像
            </UButton>
            <input ref="avatarInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" @change="handleAvatarUpload" />
        </div>
        <p class="text-sm text-text-secondary">支持 png / jpeg / webp，最大 2MB</p>
    </div>
</section>
```

（`user` 来自 `useAuth()`；`toast` / `dialog` 按 settings.vue 现有引入方式使用；`api` 已存在。）

- [ ] **Step 3: 验证构建与手动流程**

Run: `cd noj-ui && deno task lint && deno task build`
然后启动全栈手动验证：上传 → 预览更新；刷新页面头像仍在；删除 → 恢复占位。

- [ ] **Step 4: 提交**

```bash
jj describe -m "feat(ui): 设置页头像上传/删除区块（#229）"
```

---

### Task 8: 前端——社区展示位接入 UserIdentity

**Files:**
- Modify: `noj-ui/components/feature/FollowingFeed.vue`（author 行）
- Modify: `noj-ui/components/feature/community/CommentCard.vue`
- Modify: `noj-ui/pages/community/index.vue`、`noj-ui/pages/community/posts/[postId].vue`、`noj-ui/pages/community/bookmarks.vue`、`noj-ui/pages/community/notifications.vue`
- Modify: `noj-ui/pages/admin/community.vue`

**Interfaces:**
- Consumes: `UserIdentity`（Task 6）；community 响应 `author: { id, username, avatar_url }`（Task 4）

- [ ] **Step 1: 逐个替换用户名文本**

模式（以 CommentCard.vue 为例）：

```vue
<!-- 之前 -->
<span class="text-sm font-medium">{{ row.author.username }}</span>
<!-- 之后 -->
<UserIdentity :user="row.author" size="sm" />
```

- 帖子/评论卡片：`<UserIdentity :user="author" size="sm" />`（原 `username.charAt(0)` 圆形占位一并移除）；
- 动态流 FollowingFeed：`<UserIdentity :user="item.author" size="sm" />`；
- bookmarks / notifications / admin/community：作者行同上；
- 检查各文件是否引入组件（Nuxt 自动导入 components/shared/*，无需手动 import——确认 nuxt.config 的 components 配置包含 shared 目录；若未自动导入则在 script 中 `import UserIdentity from '~/components/shared/UserIdentity.vue'`）。

- [ ] **Step 2: 验证构建**

Run: `cd noj-ui && deno task lint && deno task build`
Expected: 通过；社区页手动冒烟（无头像用户显示首字母占位）。

- [ ] **Step 3: 提交**

```bash
jj describe -m "feat(ui): 社区展示位接入 UserIdentity 头像组件（#229）"
```

---

### Task 9: 前端——私信与搜索展示位接入

**Files:**
- Modify: `noj-ui/components/feature/ChatSidebar.vue`（联系人搜索结果的圆形首字母 → 头像）
- Modify: `noj-ui/pages/messages/index.vue`（会话列表）
- Modify: `noj-ui/components/feature/search/SearchResultItem.vue`（`usernameInitial` 圆形 → 头像）
- Modify: `noj-ui/pages/search.vue`（若有用户结果展示）

**Interfaces:**
- Consumes: `UserIdentity`（Task 6）；messages/search 响应（Task 4 已补 avatar_url）

- [ ] **Step 1: 替换**

ChatSidebar.vue（141 行附近）圆形首字母 → `<UserIdentity :user="u" size="sm" showUsername />`（u 为联系人对象，含 avatar_url）；messages/index.vue 会话对方用户行同样替换。SearchResultItem.vue 的 `usernameInitial` 计算属性删除，替换为 `<UserIdentity :user="item.user ?? { id: item.id, username: item.username }" size="sm" />`（以该文件实际数据形状为准）。

- [ ] **Step 2: 验证构建**

Run: `cd noj-ui && deno task lint && deno task build`
Expected: 通过；私信/搜索页冒烟。

- [ ] **Step 3: 提交**

```bash
jj describe -m "feat(ui): 私信与搜索展示位接入 UserIdentity（#229）"
```

---

### Task 10: 前端——竞赛/榜单/导航/主页等展示位接入

**Files:**
- Modify: `noj-ui/components/layout/UserMenu.vue`（lucide-user 图标 → 头像 sm + 用户名）
- Modify: `noj-ui/pages/users/[id].vue:182`（`charAt(0)` 占位 div → `UserIdentity` lg + 用户名标题）
- Modify: `noj-ui/components/feature/contest/ClarificationsPanel.vue`、`ContestRanking.vue`
- Modify: `noj-ui/pages/ranking.vue`、`noj-ui/pages/index.vue`、`noj-ui/pages/problems/[id].vue`、`noj-ui/pages/contests/index.vue`、`noj-ui/pages/contests/[contestId]/index.vue`、`noj-ui/pages/admin/users.vue`、`noj-ui/pages/admin/contests.vue`

**Interfaces:**
- Consumes: `UserIdentity`（Task 6）；`useAuth().user` 带 `avatar_url`（Task 7）

- [ ] **Step 1: UserMenu 替换**

UserMenu.vue 中按钮区域：

```vue
<!-- 之前 -->
<UIcon name="i-lucide-user" class="size-[22px]" />
<!-- 之后 -->
<UserIdentity v-if="user" :user="user" :show-username="false" size="sm" :link="false" />
```

（注意外层已是按钮/下拉触发器，`link=false` 避免嵌套链接；菜单头部用户名行保持文本即可。）

- [ ] **Step 2: 用户主页替换**

users/[id].vue:182 首字母 div → `<UserIdentity :user="profile.user" :show-username="false" size="lg" />` 放在 `<h1>` 前 flex 容器内。

- [ ] **Step 3: 其余展示位**

ClarificationsPanel（答疑人）、ContestRanking / ranking（用户名行）、index.vue（最新动态/提交者）、problems/[id]（提交者）、contests 两页（创建者/参赛者）、admin/users 与 admin/contests（列表行内加 sm 头像）——统一 `<UserIdentity :user="..." size="sm" />`（纯文本场景保留 `showUsername` 默认；纯装饰场景可 `:show-username="false"`）。

- [ ] **Step 4: 验证构建**

Run: `cd noj-ui && deno task lint && deno task build`
Expected: 通过；导航栏/用户主页/榜单/竞赛页冒烟。

- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(ui): 导航栏与其余展示位接入 UserIdentity（#229）"
```

---

### Task 11: E2E——noj-tests 头像用例（issue 验收）

**Files:**
- Create: `noj-tests/e2e/29_avatar.test.ts`

**Interfaces:**
- Consumes: `helper.ts` 的 `registerUser` / `loginUser` / `apiGet` / `apiDelete` / `e2eTest` / `TEST_PASSWORD`；端点（Task 3）
- Produces: issue #229 验收用例（上传/替换/删除、超限与非法类型被拒、无头像默认展示）

- [ ] **Step 1: 编写测试**

```ts
import {
  apiDelete,
  apiGet,
  e2eTest,
  loginUser,
  registerUser,
  TEST_PASSWORD,
} from "./helper.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

function avatarForm(name: string, type: string, data: Uint8Array): FormData {
  const fd = new FormData();
  fd.append("file", new File([data], name, { type }));
  return fd;
}

e2eTest("头像：上传/替换/删除全流程", async () => {
  const username = `avatar_${Date.now()}`;
  await registerUser(username, TEST_PASSWORD);
  const token = (await loginUser(username, TEST_PASSWORD)).token;
  const userId = (await apiGet("/api/v1/auth/me", token)).data.user.id;

  // 无头像默认展示：GET 404
  const none = await apiGet(`/api/v1/users/${userId}/avatar`);
  if (none.status !== 404) throw new Error(`无头像应 404，实际 ${none.status}`);

  // 上传
  const up = await fetch(`${BASE}/api/v1/users/me/avatar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: avatarForm("a.png", "image/png", PNG),
  });
  if (up.status !== 200) throw new Error(`上传失败: ${up.status} ${await up.text()}`);
  const avatarUrl = (await up.json()).data.avatar_url as string;
  if (!avatarUrl.startsWith("noj-storage://")) throw new Error("avatar_url 格式错误");

  // 展示
  const show = await fetch(`${BASE}/api/v1/users/${userId}/avatar`);
  if (show.status !== 200 || show.headers.get("content-type") !== "image/png") {
    throw new Error(`展示失败: ${show.status} ${show.headers.get("content-type")}`);
  }

  // 替换（jpeg）
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const rep = await fetch(`${BASE}/api/v1/users/me/avatar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: avatarForm("b.jpg", "image/jpeg", jpeg),
  });
  if (rep.status !== 200) throw new Error(`替换失败: ${rep.status}`);
  const show2 = await fetch(`${BASE}/api/v1/users/${userId}/avatar`);
  if (show2.headers.get("content-type") !== "image/jpeg") throw new Error("替换后 Content-Type 应为 image/jpeg");

  // 删除（幂等）
  const del1 = await apiDelete("/api/v1/users/me/avatar", token);
  if (del1.status !== 204) throw new Error(`删除失败: ${del1.status}`);
  const del2 = await apiDelete("/api/v1/users/me/avatar", token);
  if (del2.status !== 204) throw new Error("删除应幂等");
  const gone = await apiGet(`/api/v1/users/${userId}/avatar`);
  if (gone.status !== 404) throw new Error("删除后应 404");
});

e2eTest("头像：超限文件与非法类型被拒", async () => {
  const username = `avatar_bad_${Date.now()}`;
  await registerUser(username, TEST_PASSWORD);
  const token = (await loginUser(username, TEST_PASSWORD)).token;

  const cases: [string, string, Uint8Array][] = [
    ["big.png", "image/png", new Uint8Array(2 * 1024 * 1024 + 1).fill(0x89)],
    ["a.txt", "text/plain", new TextEncoder().encode("hi")],
    ["a.svg", "image/svg+xml", new TextEncoder().encode("<svg></svg>")],
    ["fake.png", "image/png", new TextEncoder().encode("not-a-real-png")],
  ];
  for (const [name, type, data] of cases) {
    const res = await fetch(`${BASE}/api/v1/users/me/avatar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: avatarForm(name, type, data),
    });
    if (res.status !== 400) throw new Error(`应拒绝 ${name}，实际 ${res.status}`);
  }
});
```

（`BASE` 从 helper.ts 导入；`apiGet` 返回 `{ status, data }` 结构以 helper 实际为准——先读 helper.ts 的 apiGet 实现再对齐字段名。）

- [ ] **Step 2: 运行 E2E**

Run: `cd noj-tests && deno task test`（需完整栈：`./run-e2e.sh` 或 scripts/e2e 编排，见 E2E_TESTING.md）
Expected: 两个用例 PASS，其余既有用例无回归。

- [ ] **Step 3: 提交**

```bash
jj describe -m "test(root): 头像上传 E2E 测试（#229）"
```

---

### Task 12: OpenSpec 变更提案

**Files:**
- Create: `openspec/changes/avatar-profile/proposal.md`
- Create: `openspec/changes/avatar-profile/specs/database-schema/`（delta）
- Create: `openspec/changes/avatar-profile/specs/user-profile/`（delta）

**Interfaces:**
- Consumes: 设计文档 `dev-docs/superpowers/specs/2026-08-12-avatar-profile-design.md`

- [ ] **Step 1: 起草提案与 delta specs**

按 OpenSpec 目录惯例（参考 `openspec/changes/archive/` 既有结构）：proposal.md 写明背景/变更/任务；database-schema delta 声明 `users.avatar_url` 列；user-profile delta 声明上传/删除/展示端点行为与校验约束（≤2MB、png/jpeg/webp、拒绝 SVG、GET 404 语义）。

- [ ] **Step 2: 提交**

```bash
jj describe -m "docs(root): 头像上传 OpenSpec 变更提案（#229）"
```

---

## Self-Review 记录（写作时执行）

- **Spec coverage**：设计文档 8 节全部映射——数据层→T1；存储层泛化→T2；API 三端点→T3；全响应 avatar_url→T4；代理透传→T5；UserIdentity→T6；设置页→T7；展示位清单→T8/9/10；测试计划（core 单测→T2/T3/T4，E2E→T11）；OpenSpec→T12。设计决策 4（校验链）在 T3；决策 5（清理顺序）在 T3；决策 6（缓存）在 T3/T5/T7。
- **Placeholder scan**：无 TBD/TODO；T3 测试中 `registerAndGetToken` 标注"复制 auth.test.ts 逻辑"，实现者需照抄既有代码——属显式指引，非占位符。
- **Type consistency**：`updateUserAvatar/clearUserAvatar/getUserAvatarBytes` 签名在 T3 定义并被 T3 路由使用；`UserIdentity` props 在 T6 定义并被 T7-T10 使用；`avatar_url` 列名全计划一致。
