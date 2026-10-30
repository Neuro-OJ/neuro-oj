import { assert, assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import {
  domainProblemBindings,
  domains,
  problems,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import { signToken } from "../../../access/identity/index.ts";
import { assignmentFixture } from "../../../education/tests/_assignment-fixture.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";

async function fixture() {
  const f = await assignmentFixture();
  await initRedisForTest();
  const app = createApp();
  const ownerToken = await signToken({ sub: f.owner, role: "user" });
  const studentToken = await signToken({ sub: f.student, role: "user" });
  return {
    ...f,
    app,
    ownerToken,
    studentToken,
    sourcePath: `/api/v1/domains/${f.school.slug}`,
    targetPath: `/api/v1/domains/${f.other.slug}`,
    sourceRef: `${f.school.slug}:1001`,
  };
}

Deno.test("资源管理 HTTP：已删除实时共享接口，隐藏域仍不可探测", async () => {
  const f = await fixture();
  for (const method of ["GET", "POST"]) {
    const response = await jsonRequest(
      f.app,
      `${f.sourcePath}/problems/1001/sharing`,
      {
        token: f.ownerToken,
        method,
        ...(method === "POST" ? { body: { enabled: true } } : {}),
      },
    );
    assertEquals(response.status, 404);
  }
  const hidden = await jsonRequest(f.app, `${f.targetPath}/problems/1001`);
  assertEquals(hidden.status, 404);
});

Deno.test("资源管理 HTTP：复制产生独立本域身份、已发布 V1，源变化不影响副本", async () => {
  const f = await fixture();
  const response = await jsonRequest(
    f.app,
    `${f.targetPath}/problem-bindings`,
    {
      method: "POST",
      token: f.ownerToken,
      body: { source_ref: f.sourceRef, version_id: f.versionId },
    },
  );
  assertEquals(response.status, 201, await response.clone().text());
  const saved = (await response.json()).data;
  assert(saved.binding.problem_id !== f.problemId);
  assertEquals(saved.binding.domain_id, f.other.id);
  assertEquals(saved.binding.kind, "owned");
  const [copy] = await f.db.select().from(problems).where(
    eq(problems.id, saved.binding.problem_id),
  );
  const [version] = await f.db.select().from(problemVersions).where(
    eq(problemVersions.problem_id, copy.id),
  );
  assertEquals(version.version, 1);
  assertEquals(
    (version.content as { description: string }).description,
    "题面",
  );
  await f.db.update(problems).set({ title: "源题已改名" }).where(
    eq(problems.id, f.problemId),
  );
  await f.db.update(domainProblemBindings).set({
    disabled_at: new Date().toISOString(),
  }).where(eq(domainProblemBindings.id, f.bindingId));
  const detail = await jsonRequest(
    f.app,
    `${f.targetPath}/problems/${copy.number}`,
    { token: f.ownerToken },
  );
  assertEquals(detail.status, 200);
  assertEquals((await detail.json()).content.title, "教学题");
  assertEquals(
    (await jsonRequest(f.app, `${f.targetPath}/problems/${f.sourceRef}`, {
      token: f.ownerToken,
    })).status,
    404,
  );
});

Deno.test("资源管理 HTTP：复制要求目标创建发布及源编辑权限，版本必须属于来源题", async () => {
  const f = await fixture(), path = `${f.targetPath}/problem-bindings`;
  const denied = await jsonRequest(f.app, path, {
    method: "POST",
    token: f.studentToken,
    body: { source_ref: f.sourceRef },
  });
  assertEquals(denied.status, 403);
  const invalid = await jsonRequest(f.app, path, {
    method: "POST",
    token: f.ownerToken,
    body: { source_ref: f.sourceRef, version_id: crypto.randomUUID() },
  });
  assertEquals(invalid.status, 404);
  assertEquals(
    (await f.db.select().from(problems).where(
      eq(problems.domain_id, f.other.id),
    )).length,
    0,
  );
  await f.db.update(domains).set({
    configuration: { ...f.school.configuration, access: "public" },
  }).where(eq(domains.id, f.school.id));
  // 可读来源不等于有权导出完整内容。
  const sourceReadable = await jsonRequest(
    f.app,
    `${f.sourcePath}/problems/1001`,
    { token: f.studentToken },
  );
  assertEquals(sourceReadable.status, 200);
});
