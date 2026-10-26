import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import { domainLimits, domains, users } from "../../../../shared/db/schema.ts";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { signToken } from "../../../identity/index.ts";
import {
  createDomain,
  getDomainStorageUsage,
} from "../../../workspace/index.ts";
import {
  createAnnouncement,
  createSlide,
  ensureRbacSeeds,
  initSystemSettings,
  runWithContext,
  updateAnnouncement,
} from "../../index.ts";
import {
  buildAnnouncementEntry,
  upsertSearchEntry,
} from "../../../search/index.ts";
import { searchFlat } from "../../../search/index.ts";

await initRedisForTest();

async function fixture() {
  await resetDbForTest();
  await ensureRbacSeeds();
  await initSystemSettings();
  const db = getDb(), now = new Date().toISOString();
  const a = crypto.randomUUID(), b = crypto.randomUUID();
  await db.insert(users).values([a, b].map((id) => ({
    id,
    username: id,
    email: `${id}@example.com`,
    created_at: now,
    updated_at: now,
  })));
  const first = await createDomain(
    { slug: "content-first", name: "第一域", preset: "community" },
    a,
    { approved: true },
  );
  const second = await createDomain(
    { slug: "content-second", name: "第二域", preset: "team" },
    b,
    { approved: true },
  );
  const app = createApp(),
    tokenA = await signToken({ sub: a, role: "user" }),
    tokenB = await signToken({ sub: b, role: "user" });
  const instanceNotice = await runWithContext(
    { actorId: a, actorIp: "127.0.0.1", actorRole: "user" },
    () =>
      createAnnouncement({
        title: "运营边界 实例公告",
        content: "公共通知",
        banner_text: "实例横幅",
      }),
  );
  const instanceSlide = await createSlide({ kind: "text", title: "实例轮播" });
  return {
    db,
    app,
    first,
    second,
    a,
    b,
    tokenA,
    tokenB,
    instanceNotice,
    instanceSlide,
    pathA: `/api/v1/domains/${first.slug}`,
    pathB: `/api/v1/domains/${second.slug}`,
  };
}

Deno.test("域运营：合并实例与本域内容、实例优先、实例接口不返回域内容", async () => {
  const f = await fixture();
  const created = await jsonRequest(
    f.app,
    `${f.pathA}/settings/announcements`,
    {
      method: "POST",
      token: f.tokenA,
      body: {
        title: "运营边界 本域公告",
        content: "学校通知",
        is_pinned: true,
        banner_text: "本域横幅",
        domain_id: f.second.id,
      },
    },
  );
  assertEquals(created.status, 201);
  const notice = (await created.json()).data;
  assertEquals(notice.domain_id, f.first.id);
  assertEquals(notice.scope, "domain");
  const read = await jsonRequest(f.app, `${f.pathA}/announcements`);
  assertEquals(read.status, 200);
  assertEquals(
    (await read.json()).data.map((item: { id: string }) => item.id),
    [f.instanceNotice.id, notice.id],
  );
  const banner =
    await (await jsonRequest(f.app, `${f.pathA}/announcements/banner`)).json();
  assertEquals(banner.data.id, f.instanceNotice.id);
  const global = await (await jsonRequest(f.app, "/api/v1/announcements"))
    .json();
  assertEquals(global.data.map((item: { id: string }) => item.id), [
    f.instanceNotice.id,
  ]);
  assertEquals(
    (await jsonRequest(f.app, `/api/v1/announcements/${notice.id}`)).status,
    404,
  );
  assertEquals(
    (await jsonRequest(f.app, `${f.pathB}/announcements/${notice.id}`, {
      token: f.tokenB,
    })).status,
    404,
  );
  assertEquals(
    (await jsonRequest(f.app, `${f.pathA}/announcements/${notice.public_id}`))
      .status,
    200,
  );
  assertEquals(
    (await jsonRequest(
      f.app,
      `${f.pathA}/settings/announcements/${notice.id}`,
      {
        method: "PUT",
        token: f.tokenA,
        body: { is_active: false },
      },
    )).status,
    200,
  );
  const hidden = await (await jsonRequest(f.app, `${f.pathA}/announcements`))
    .json();
  assertEquals(hidden.data.map((item: { id: string }) => item.id), [
    f.instanceNotice.id,
  ]);
  assertEquals(
    (await jsonRequest(f.app, `${f.pathA}/announcements/${notice.id}`)).status,
    404,
  );
});

Deno.test("域运营管理：成员权限与资源归属独立校验，轮播排序仅影响本域", async () => {
  const f = await fixture();
  const created = await jsonRequest(
    f.app,
    `${f.pathA}/settings/carousel/slides`,
    {
      method: "POST",
      token: f.tokenA,
      body: { kind: "text", title: "本域轮播" },
    },
  );
  assertEquals(created.status, 201);
  const slideId = (await created.json()).data.id;
  const otherId = await createSlide({ kind: "text", title: "第二域轮播" }, {
    domainId: f.second.id,
  });
  assertEquals(
    (await jsonRequest(f.app, `${f.pathA}/settings/carousel/slides`, {
      token: f.tokenB,
    })).status,
    403,
  );
  for (const id of [f.instanceSlide, otherId]) {
    assertEquals(
      (await jsonRequest(f.app, `${f.pathA}/settings/carousel/slides/${id}`, {
        method: "PATCH",
        token: f.tokenA,
        body: { title: "不能修改" },
      })).status,
      404,
    );
  }
  assertEquals(
    (await jsonRequest(f.app, `${f.pathA}/settings/carousel/slides/reorder`, {
      method: "POST",
      token: f.tokenA,
      body: { ids: [slideId] },
    })).status,
    200,
  );
  assertEquals(
    (await jsonRequest(f.app, `${f.pathA}/settings/carousel/slides/reorder`, {
      method: "POST",
      token: f.tokenA,
      body: { ids: [f.instanceSlide, slideId] },
    })).status,
    400,
  );
  const combined =
    await (await jsonRequest(f.app, `${f.pathA}/carousel/slides`)).json();
  assertEquals(combined.data.map((item: { id: string }) => item.id), [
    f.instanceSlide,
    slideId,
  ]);
  const global = await (await jsonRequest(f.app, "/api/v1/carousel/slides"))
    .json();
  assertEquals(global.data.map((item: { id: string }) => item.id), [
    f.instanceSlide,
  ]);
  assertEquals(
    (await jsonRequest(
      f.app,
      `${f.pathA}/settings/carousel/slides/${slideId}`,
      {
        method: "PATCH",
        token: f.tokenA,
        body: { is_enabled: false },
      },
    )).status,
    200,
  );
  const hidden = await (await jsonRequest(f.app, `${f.pathA}/carousel/slides`))
    .json();
  assertEquals(hidden.data.map((item: { id: string }) => item.id), [
    f.instanceSlide,
  ]);
  const notice = await runWithContext(
    { actorId: f.a, actorIp: "127.0.0.1", actorRole: "user" },
    () =>
      createAnnouncement({ title: "本域", content: "正文" }, {
        domainId: f.first.id,
      }),
  );
  await assertRejects(
    () => updateAnnouncement(notice.id, { title: "实例不能修改域内容" }),
    NotFoundError,
  );
  assertEquals(
    (await jsonRequest(
      f.app,
      `${f.pathA}/settings/announcements/${f.instanceNotice.id}`,
      {
        method: "PUT",
        token: f.tokenA,
        body: { title: "域不能修改实例内容" },
      },
    )).status,
    404,
  );
});

Deno.test("私有域轮播：图片访问受域授权、存储预占结算及删除释放有效", async () => {
  const f = await fixture();
  await f.db.update(domains).set({
    configuration: { ...f.first.configuration, access: "members" },
  }).where(eq(domains.id, f.first.id));
  const bytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4VQAAAAASUVORK5CYII=",
    ),
    (char) => char.charCodeAt(0),
  );
  const upload = async (path: string, token: string) => {
    const body = new FormData();
    body.set("file", new File([bytes], "banner.png", { type: "image/png" }));
    return await f.app.fetch(
      new Request(`http://localhost${path}/settings/carousel/images`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body,
      }),
    );
  };
  const uploaded = await upload(f.pathA, f.tokenA);
  assertEquals(uploaded.status, 201);
  const url = (await uploaded.json()).data.image_storage_url;
  assertEquals((await getDomainStorageUsage(f.first.id)).used, bytes.length);
  const created = await jsonRequest(
    f.app,
    `${f.pathA}/settings/carousel/slides`,
    {
      method: "POST",
      token: f.tokenA,
      body: { kind: "image", image_storage_url: url, title: "私有图片" },
    },
  );
  assertEquals(created.status, 201);
  const id = (await created.json()).data.id;
  const imagePath = `${f.pathA}/carousel/slides/${id}/image`;
  const allowed = await jsonRequest(f.app, imagePath, { token: f.tokenA });
  assertEquals(allowed.status, 200);
  assertEquals(allowed.headers.get("Cache-Control"), "private, no-store");
  assertEquals((await jsonRequest(f.app, imagePath)).status, 404);
  assertEquals(
    (await jsonRequest(f.app, `${f.pathB}/carousel/slides/${id}/image`, {
      token: f.tokenB,
    })).status,
    404,
  );
  assertEquals(
    (await jsonRequest(f.app, `/api/v1/carousel/slides/${id}/image`)).status,
    404,
  );
  assertEquals(
    (await jsonRequest(f.app, `${f.pathB}/settings/carousel/slides`, {
      method: "POST",
      token: f.tokenB,
      body: { kind: "image", image_storage_url: url },
    })).status,
    400,
  );
  await f.db.update(domainLimits).set({ storage_bytes: 0 }).where(
    eq(domainLimits.domain_id, f.second.id),
  );
  assertEquals((await upload(f.pathB, f.tokenB)).status, 429);
  assertEquals((await getDomainStorageUsage(f.second.id)).reserved, 0);
  assertEquals(
    (await jsonRequest(f.app, `${f.pathA}/settings/carousel/slides/${id}`, {
      method: "DELETE",
      token: f.tokenA,
    })).status,
    204,
  );
  assertEquals((await getDomainStorageUsage(f.first.id)).used, 0);
});

Deno.test("域公告搜索：实例公告全域可见，其他域及实例默认入口不泄露本域公告", async () => {
  const f = await fixture();
  const notice = await runWithContext(
    { actorId: f.a, actorIp: "127.0.0.1", actorRole: "user" },
    () =>
      createAnnouncement({
        title: "运营边界 本域搜索",
        content: "私有教学通知",
      }, { domainId: f.first.id }),
  );
  for (const id of [notice.id, f.instanceNotice.id]) {
    await upsertSearchEntry((await buildAnnouncementEntry(id))!);
  }
  const search = (domainId?: string) =>
    searchFlat({
      q: "运营边界",
      type: "announcement",
      page: 1,
      perPage: 20,
      ctx: { isAdmin: false, guestReadEnabled: true, domainId },
    });
  assertEquals((await search(f.first.id)).items.length, 2);
  assertEquals(
    (await search(f.second.id)).items.map((item) => item.entity_id),
    [f.instanceNotice.id],
  );
  assertEquals((await search()).items.map((item) => item.entity_id), [
    f.instanceNotice.id,
  ]);
});
