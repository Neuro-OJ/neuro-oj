import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../app.ts";
import { assignmentFixture } from "../../education/tests/_assignment-fixture.ts";
import { signToken } from "../../identity/index.ts";
import { initRedisForTest, jsonRequest } from "../../../../tests/helper.ts";

Deno.test("批注 HTTP：认证、无缓存、默认私密、幂等和版本前置条件", async () => {
  const f = await assignmentFixture();
  await initRedisForTest();
  const app = createApp(),
    token = await signToken({ sub: f.student, role: "user" });
  const teacherToken = await signToken({ sub: f.teacher, role: "user" });
  const root = `/api/v1/domains/${f.school.slug}/annotations`;
  assertEquals((await jsonRequest(app, root)).status, 401);
  assertEquals(
    (await jsonRequest(app, `${root}?target=invalid`, { token })).status,
    400,
  );
  const target = {
    kind: "problem",
    reference: "1001",
    version_id: f.versionId,
    field: "description",
  };
  const source = await jsonRequest(app, `${root}/source`, {
    token,
    method: "POST",
    body: { target },
  });
  assertEquals(source.status, 200);
  assertEquals(source.headers.get("Cache-Control"), "no-store");
  const text = (await source.json()).data;
  const input = {
    target,
    content_hash: text.content_hash,
    anchor: { block_id: text.blocks[0].id, start: 0, end: 2 },
    body: "私密 HTTP 笔记",
  };
  assertEquals(
    (await jsonRequest(app, root, { token, method: "POST", body: input }))
      .status,
    400,
  );
  const created = await jsonRequest(app, root, {
    token,
    method: "POST",
    headers: { "Idempotency-Key": "http-note" },
    body: input,
  });
  assertEquals(created.status, 201);
  assertEquals(created.headers.get("Cache-Control"), "no-store");
  const note = (await created.json()).data;
  assertEquals(note.visibility, "private");
  const retry = await jsonRequest(app, root, {
    token,
    method: "POST",
    headers: { "Idempotency-Key": "http-note" },
    body: input,
  });
  assertEquals((await retry.json()).data.id, note.id);
  assertEquals(
    (await jsonRequest(app, `${root}/${note.id}`, { token: teacherToken }))
      .status,
    404,
  );
  const messagePath = `${root}/${note.id}/messages/${note.messages[0].id}`;
  assertEquals(
    (await jsonRequest(app, messagePath, {
      token,
      method: "PATCH",
      body: { body: "修改" },
    })).status,
    428,
  );
  assertEquals(
    (await jsonRequest(app, messagePath, {
      token,
      method: "PATCH",
      headers: { "If-Match": "garbage" },
      body: { body: "修改" },
    })).status,
    400,
  );
  const edited = await jsonRequest(app, messagePath, {
    token,
    method: "PATCH",
    headers: { "If-Match": "0" },
    body: { body: "修改" },
  });
  assertEquals(edited.status, 200);
  assertEquals(
    (await jsonRequest(app, messagePath, {
      token,
      method: "PATCH",
      headers: { "If-Match": "0" },
      body: { body: "过期" },
    })).status,
    409,
  );
});
