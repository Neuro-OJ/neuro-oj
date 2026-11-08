import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { userActorFromAuthenticatedId } from "../../../access/contracts/actor.ts";
import { createApp } from "../../../../app.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import { users } from "../../../../shared/db/schema.ts";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { signToken } from "../../../access/identity/index.ts";
import { createDomain } from "../../../access/workspace/index.ts";
import {
  createAnnouncement,
  initSystemSettings,
  runWithContext,
  updateAnnouncement,
} from "../../system/index.ts";
import {
  buildAnnouncementEntry,
  upsertSearchEntry,
} from "../../../read-models/index.ts";
import { searchFlat } from "../../../read-models/index.ts";

await initRedisForTest();

async function fixture() {
  await resetDbForTest();
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
      }, userActorFromAuthenticatedId(a)),
  );
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

Deno.test("域运营管理：实例与本域公告互不可改", async () => {
  const f = await fixture();
  const notice = await runWithContext(
    { actorId: f.a, actorIp: "127.0.0.1", actorRole: "user" },
    () =>
      createAnnouncement(
        { title: "本域", content: "正文" },
        userActorFromAuthenticatedId(f.a),
        { domainId: f.first.id },
      ),
  );
  await assertRejects(
    () =>
      updateAnnouncement(
        notice.id,
        { title: "实例不能修改域内容" },
        userActorFromAuthenticatedId(f.a),
      ),
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

Deno.test("域公告搜索：实例公告全域可见，其他域及实例默认入口不泄露本域公告", async () => {
  const f = await fixture();
  const notice = await runWithContext(
    { actorId: f.a, actorIp: "127.0.0.1", actorRole: "user" },
    () =>
      createAnnouncement(
        {
          title: "运营边界 本域搜索",
          content: "私有教学通知",
        },
        userActorFromAuthenticatedId(f.a),
        { domainId: f.first.id },
      ),
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
