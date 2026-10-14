import { assert, assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import {
  domainProblemBindings,
  domains,
  problemBindingHistory,
  problems,
} from "../../../../shared/db/schema.ts";
import { signToken } from "../../../identity/index.ts";
import {
  createDomain,
  setMemberRoles,
  updateDomain,
} from "../../../workspace/index.ts";
import { assignmentFixture } from "../../../education/tests/_assignment-fixture.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { domainResourceManagementRouter } from "../../routes/domain-resource-management.ts";
import { domainTrainingsRouter } from "../../routes/domain-trainings.ts";
import { domainProblemsRouter } from "../../routes/domain-problems.ts";
import { setDomainProblemSharing } from "../../services/workspace/problem-sharing.ts";
import { saveDomainTraining } from "../../services/workspace/trainings.ts";

async function fixture() {
  const f = await assignmentFixture();
  await initRedisForTest();
  await updateDomain(f.school.slug, f.owner, f.school.revision, {
    configuration: {
      ...f.school.configuration,
      access: "public",
      discoverable: true,
    },
  });
  await f.db.update(problems).set({ visibility: "public" }).where(
    eq(problems.id, f.problemId),
  );
  await f.db.update(domainProblemBindings).set({ visibility: "public" }).where(
    eq(domainProblemBindings.id, f.bindingId),
  );
  const app = createApp();
  app.route("/api/v1", domainResourceManagementRouter);
  app.route("/api/v1", domainTrainingsRouter);
  app.route("/api/v1", domainProblemsRouter);
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
async function share(f: Awaited<ReturnType<typeof fixture>>) {
  await setDomainProblemSharing(f.school.slug, "1001", f.owner, {
    enabled: true,
    scope: "all",
    expectedRevision: 0,
    targetDomainIds: [],
  });
}

Deno.test("资源管理 HTTP：共享 GET/POST 使用目标 slug，权限与 revision 生效，隐藏域不被探测", async () => {
  const f = await fixture(), path = `${f.sourcePath}/problems/1001/sharing`;
  const initial = await jsonRequest(f.app, path, { token: f.ownerToken });
  assertEquals(initial.status, 200);
  assertEquals((await initial.json()).data, {
    enabled: false,
    scope: "all",
    revision: 0,
    target_domains: [],
  });
  assertEquals(
    (await jsonRequest(f.app, path, { token: f.studentToken })).status,
    403,
  );
  const selected = {
    enabled: true,
    scope: "selected",
    target_domain_slugs: [f.other.slug],
  };
  assertEquals(
    (await jsonRequest(f.app, path, {
      method: "POST",
      token: f.ownerToken,
      body: selected,
    })).status,
    428,
  );
  const hidden = await createDomain({
    slug: "hidden-target",
    name: "不可发现学校",
    preset: "education",
  }, f.teacher);
  assertEquals(
    (await jsonRequest(f.app, path, {
      method: "POST",
      token: f.ownerToken,
      headers: { "If-Match": "0" },
      body: { ...selected, target_domain_slugs: [hidden.slug] },
    })).status,
    404,
  );
  const saved = await jsonRequest(f.app, path, {
    method: "POST",
    token: f.ownerToken,
    headers: { "If-Match": "0" },
    body: selected,
  });
  assertEquals(saved.status, 200);
  const policy = (await saved.json()).data;
  assertEquals(policy.revision, 1);
  assertEquals(policy.target_domains, [{
    id: f.other.id,
    slug: f.other.slug,
    name: f.other.name,
  }]);
  const current =
    (await (await jsonRequest(f.app, path, { token: f.ownerToken })).json())
      .data;
  assertEquals(current.target_domains, policy.target_domains);
  assertEquals(
    (await jsonRequest(f.app, path, {
      method: "POST",
      token: f.ownerToken,
      headers: { "If-Match": "0" },
      body: selected,
    })).status,
    409,
  );
  assertEquals(
    (await jsonRequest(
      f.app,
      `${f.targetPath}/problems/${f.sourceRef}/sharing`,
      { token: f.ownerToken },
    )).status,
    404,
  );
  // 可发现的私有域只暴露允许展示的身份摘要，不要求源管理员加入该校。
  await f.db.update(domains).set({
    configuration: { ...hidden.configuration, discoverable: true },
  }).where(eq(domains.id, hidden.id));
  const discoverable = await jsonRequest(f.app, path, {
    method: "POST",
    token: f.ownerToken,
    headers: { "If-Match": "1" },
    body: { ...selected, target_domain_slugs: [hidden.slug] },
  });
  assertEquals(discoverable.status, 200);
  assertEquals(
    (await discoverable.json()).data.target_domains[0].slug,
    hidden.slug,
  );
});

Deno.test("资源管理 HTTP：引用分页、独立策略、下架恢复及源撤销即时裁剪", async () => {
  const f = await fixture();
  await share(f);
  const bindings = `${f.targetPath}/problem-bindings`;
  assertEquals(
    (await jsonRequest(f.app, bindings, { token: f.studentToken })).status,
    403,
  );
  const imported = await jsonRequest(f.app, bindings, {
    method: "POST",
    token: f.ownerToken,
    body: { source_ref: f.sourceRef },
  });
  assertEquals(imported.status, 201);
  const saved = (await imported.json()).data;
  assertEquals(saved.reference.display_ref, f.sourceRef);
  const duplicate = await jsonRequest(f.app, bindings, {
    method: "POST",
    token: f.ownerToken,
    body: { source_ref: f.sourceRef },
  });
  assertEquals((await duplicate.json()).data.binding.id, saved.binding.id);
  const first = await (await jsonRequest(f.app, `${bindings}?page=1&limit=1`, {
    token: f.ownerToken,
  })).json();
  assertEquals(first.total, 1);
  assertEquals(first.items[0].resource_available, true);
  assertEquals(first.items[0].can_edit, false);
  assertEquals(first.items[0].can_share, false);
  assertEquals(first.items[0].answer_version_id, f.versionId);
  const policyPath = `${f.targetPath}/problems/${f.sourceRef}/policy`;
  const policy = {
    policy: { mode: "exact", version_id: f.versionId },
    reason: "明确当前作答版本",
  };
  assertEquals(
    (await jsonRequest(f.app, policyPath, {
      method: "PUT",
      token: f.ownerToken,
      body: policy,
    })).status,
    428,
  );
  const changed = await jsonRequest(f.app, policyPath, {
    method: "PUT",
    token: f.ownerToken,
    headers: { "If-Match": "0" },
    body: policy,
  });
  assertEquals(changed.status, 200);
  assertEquals((await changed.json()).data.revision, 1);
  assertEquals(
    (await jsonRequest(f.app, policyPath, {
      method: "PUT",
      token: f.ownerToken,
      headers: { "If-Match": "0" },
      body: policy,
    })).status,
    409,
  );
  const statePath = `${f.targetPath}/problems/${f.sourceRef}/state`;
  const disabled = await jsonRequest(f.app, statePath, {
    method: "POST",
    token: f.ownerToken,
    headers: { "If-Match": "1" },
    body: { disabled: true, reason: "暂时下架" },
  });
  assertEquals(disabled.status, 200);
  const down =
    (await (await jsonRequest(f.app, bindings, { token: f.ownerToken })).json())
      .items[0];
  assert(down.disabled_at);
  assertEquals(down.resource_available, false);
  assertEquals(down.title, null);
  assertEquals(down.reference.display_ref, f.sourceRef);
  await setMemberRoles(f.other.slug, f.owner, f.teacher, ["educator"]);
  const teacherToken = await signToken({ sub: f.teacher, role: "user" });
  assertEquals(
    (await jsonRequest(f.app, bindings, {
      method: "POST",
      token: teacherToken,
      body: { source_ref: f.sourceRef },
    })).status,
    403,
  );
  const restored = await jsonRequest(f.app, bindings, {
    method: "POST",
    token: f.ownerToken,
    body: { source_ref: f.sourceRef },
  });
  assertEquals(restored.status, 201);
  const restoration = (await restored.json()).data.binding;
  assertEquals(restoration.id, saved.binding.id);
  assertEquals(restoration.revision, 3);
  assertEquals(restoration.disabled_at, null);
  const [history] = await f.db.select().from(problemBindingHistory).where(
    and(
      eq(problemBindingHistory.binding_id, saved.binding.id),
      eq(problemBindingHistory.revision, 3),
    ),
  );
  assertEquals(history.reason, "恢复引用");
  assertEquals(history.disabled_at, null);
  assertEquals(
    (await jsonRequest(f.app, statePath, {
      method: "POST",
      token: f.ownerToken,
      headers: { "If-Match": "3" },
      body: { disabled: true, reason: "再次下架验证显式状态恢复" },
    })).status,
    200,
  );
  assertEquals(
    (await jsonRequest(f.app, statePath, {
      method: "POST",
      token: f.ownerToken,
      headers: { "If-Match": "4" },
      body: { disabled: false, reason: "恢复练习" },
    })).status,
    200,
  );
  await setDomainProblemSharing(f.school.slug, "1001", f.owner, {
    enabled: false,
    scope: "all",
    expectedRevision: 1,
    targetDomainIds: [],
  });
  const revoked =
    (await (await jsonRequest(f.app, bindings, { token: f.ownerToken })).json())
      .items[0];
  assertEquals(revoked.resource_available, false);
  assertEquals(revoked.title, null);
  assertEquals(
    (await jsonRequest(f.app, `${f.targetPath}/problems/${f.sourceRef}`, {
      token: f.studentToken,
    })).status,
    404,
  );
  assertEquals(
    (await jsonRequest(f.app, bindings, {
      method: "POST",
      token: f.ownerToken,
      body: { source_ref: f.sourceRef },
    })).status,
    404,
  );
  assertEquals(
    (await jsonRequest(f.app, statePath, {
      method: "POST",
      token: f.ownerToken,
      headers: { "If-Match": "5" },
      body: { disabled: false, reason: "不能绕过源撤销" },
    })).status,
    404,
  );
  const keyword = await (await jsonRequest(
    f.app,
    `${bindings}?keyword=${encodeURIComponent("教学题")}`,
    { token: f.ownerToken },
  )).json();
  assertEquals(keyword.total, 0);
  const discovery = await (await jsonRequest(
    f.app,
    `${f.targetPath}/shared-resources?kind=problem&source_slug=${f.school.slug}`,
    { token: f.ownerToken },
  )).json();
  assertEquals(discovery.total, 0);
});

Deno.test("资源管理 HTTP：公开来源发现按当前目标授权分页，不返回源内容或私有题单", async () => {
  const f = await fixture();
  const path =
    `${f.targetPath}/shared-resources?kind=problem&source_slug=${f.school.slug}&limit=1`;
  assertEquals(
    (await (await jsonRequest(f.app, path, { token: f.ownerToken })).json())
      .total,
    0,
  );
  await share(f);
  const available =
    await (await jsonRequest(f.app, path, { token: f.ownerToken })).json();
  assertEquals(available.total, 1);
  assertEquals(available.items[0].reference.qualified_ref, f.sourceRef);
  assertEquals(available.items[0].kind, "ai");
  assertEquals(Object.hasOwn(available.items[0], "content"), false);
  assertEquals(
    (await jsonRequest(f.app, path, { token: f.studentToken })).status,
    403,
  );
  const privateTraining = await saveDomainTraining(f.school.slug, f.owner, {
    title: "隐藏题单标题",
    visibility: "private",
    problems: ["1001"],
  });
  const hidden = await (await jsonRequest(
    f.app,
    `${f.sourcePath}/trainings?keyword=${
      encodeURIComponent(privateTraining.title)
    }`,
    { token: f.studentToken },
  )).json();
  assertEquals(hidden.total, 0);
  const owned = await (await jsonRequest(f.app, `${f.sourcePath}/trainings`, {
    token: f.ownerToken,
  })).json();
  assertEquals(owned.items[0].can_edit, true);
});

Deno.test("资源管理 HTTP：题单共享、可编辑 DTO 与逐题目标绑定保持使用域", async () => {
  const f = await fixture();
  await share(f);
  const training = await saveDomainTraining(f.school.slug, f.owner, {
    title: "公开训练",
    visibility: "public",
    problems: ["1001"],
  });
  const sharing = `${f.sourcePath}/trainings/${training.id}/sharing`;
  const initial =
    (await (await jsonRequest(f.app, sharing, { token: f.ownerToken })).json())
      .data;
  assertEquals(initial.revision, 0);
  const allowed = await jsonRequest(f.app, sharing, {
    method: "POST",
    token: f.ownerToken,
    headers: { "If-Match": "0" },
    body: { enabled: true, scope: "all", target_domain_slugs: [] },
  });
  assertEquals(allowed.status, 200);
  assertEquals((await allowed.json()).data.target_domains, []);
  const sources = await (await jsonRequest(
    f.app,
    `${f.targetPath}/shared-resources?kind=training&source_slug=${f.school.slug}`,
    { token: f.ownerToken },
  )).json();
  assertEquals(sources.items[0].id, training.id);
  const imported = await jsonRequest(
    f.app,
    `${f.targetPath}/training-bindings`,
    { method: "POST", token: f.ownerToken, body: { training_id: training.id } },
  );
  assertEquals(imported.status, 201);
  const readPath = `${f.targetPath}/trainings/${training.id}`;
  const before =
    (await (await jsonRequest(f.app, readPath, { token: f.ownerToken })).json())
      .data;
  assertEquals(before.visibility, "public");
  assertEquals(before.can_edit, false);
  assertEquals(before.can_share, false);
  assertEquals(before.domain_id, f.other.id);
  assertEquals(before.items[0].binding_id, null);
  assertEquals(before.items[0].can_import, true);
  assertEquals(before.items[0].display_ref, f.sourceRef);
  await jsonRequest(f.app, `${f.targetPath}/problem-bindings`, {
    method: "POST",
    token: f.ownerToken,
    body: { source_ref: f.sourceRef },
  });
  const student =
    (await (await jsonRequest(f.app, readPath, { token: f.studentToken }))
      .json()).data;
  assert(student.items[0].binding_id);
  assertEquals(student.items[0].resource_available, true);
  assertEquals(student.items[0].can_import, false);
  assertEquals(student.items[0].display_ref, f.sourceRef);
  assertEquals(Object.hasOwn(student.items[0], "content"), false);
  const list = await (await jsonRequest(f.app, `${f.targetPath}/trainings`, {
    token: f.studentToken,
  })).json();
  assertEquals(list.items[0].is_shared, true);
  assertEquals(list.items[0].source_domain_slug, f.school.slug);
  await setDomainProblemSharing(f.school.slug, "1001", f.owner, {
    enabled: false,
    scope: "all",
    expectedRevision: 1,
    targetDomainIds: [],
  });
  const unavailable =
    (await (await jsonRequest(f.app, readPath, { token: f.studentToken }))
      .json()).data;
  assertEquals(unavailable.items[0].resource_available, false);
  assertEquals(unavailable.items[0].binding_id, null);
  const revoked = await jsonRequest(f.app, sharing, {
    method: "POST",
    token: f.ownerToken,
    headers: { "If-Match": "1" },
    body: { enabled: false, scope: "all", target_domain_slugs: [] },
  });
  assertEquals(revoked.status, 200);
  assertEquals(
    (await jsonRequest(f.app, readPath, { token: f.studentToken })).status,
    404,
  );
  assertEquals(
    (await (await jsonRequest(f.app, `${f.targetPath}/trainings`, {
      token: f.studentToken,
    })).json()).total,
    0,
  );
});
