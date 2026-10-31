import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { AppError } from "../../../../../shared/base/errors.ts";
import { signToken } from "../../../../access/identity/index.ts";
import { createPost, withDomainCommunity } from "../../index.ts";
import { domainCommunityRouter } from "../../routes/domain-community.ts";
import { domainFixture, sharedItem } from "../services/domain-fixture.ts";
import { jsonRequest } from "../../../../../../tests/helper.ts";

Deno.test("域社区题号：引用题解显示来源题号，普通讨论无题目关联", async () => {
  const f = await domainFixture("post-reference"), item = await sharedItem(f);
  const post = await withDomainCommunity(f.target.slug, f.b, {
    write: true,
    permission: "community:create",
  }, (scope) =>
    createPost(
      f.b,
      {
        type: "solution",
        problem_id: item.id,
        title: "引用题解",
        content: "学校题解",
      },
      true,
      scope,
    ));
  const app = new Hono();
  app.route("/api/v1", domainCommunityRouter);
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json({ error: error.message }, error.statusCode as 400);
    }
    throw error;
  });
  const token = await signToken({ sub: f.student, role: "user" });
  const read = await jsonRequest(
    app,
    `/api/v1/domains/${f.target.slug}/community/posts/${post.id}`,
    { token },
  );
  assertEquals(read.status, 200);
  const { data } = await read.json();
  assertEquals(data.post.domain_id, f.target.id);
  assertEquals(data.problem_title, "source problem");
  assertEquals(data.problem_reference, {
    problem_id: item.id,
    source_domain_id: f.target.id,
    source_domain_slug: f.target.slug,
    number: 1001,
    qualified_ref: `${f.target.slug}:1001`,
    display_ref: "1001",
    is_shared: false,
  });
  assertEquals("problem_identity" in data, false);
  const discussion = await jsonRequest(
    app,
    `/api/v1/domains/${f.target.slug}/community/posts/${f.postB.id}`,
    { token },
  );
  assertEquals(discussion.status, 200);
  assertEquals((await discussion.json()).data.problem_reference, null);
  const wrong = await jsonRequest(
    app,
    `/api/v1/domains/${f.source.slug}/community/posts/${post.id}`,
    { token },
  );
  assertEquals(wrong.status, 404);
});
