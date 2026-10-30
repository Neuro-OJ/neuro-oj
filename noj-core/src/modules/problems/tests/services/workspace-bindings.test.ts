import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  domainLimits,
  domainProblemBindings,
  problemBindingHistory,
  problems,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import { assignmentFixture } from "../../../education/tests/_assignment-fixture.ts";
import { setMemberRoles } from "../../../access/workspace/index.ts";
import {
  importDomainProblem,
  setDomainProblemBindingPolicy,
  setDomainProblemBindingState,
} from "../../services/workspace/problem-bindings.ts";
import {
  listDomainProblems,
  listDomainProblemVersions,
  readDomainProblem,
  readDomainProblemTemplate,
} from "../../services/workspace/problem-read.ts";
import { resolveDomainProblem } from "../../services/workspace/problem-binding-access.ts";

async function copied() {
  const f = await assignmentFixture();
  const result = await importDomainProblem(
    f.other.slug,
    `${f.school.slug}:1001`,
    f.owner,
  );
  const [problem] = await f.db.select().from(problems).where(
    eq(problems.id, result.binding.problem_id),
  );
  return { ...f, result, copy: problem, reference: String(problem.number) };
}

Deno.test("域作答附件：副本只有独立 V1，模板与版本目录不返回评测配置", async () => {
  const f = await copied();
  const read = await readDomainProblem(f.other.slug, f.reference, f.student);
  assertEquals(read.content.title, "教学题");
  const template = await readDomainProblemTemplate(
    f.other.slug,
    f.reference,
    f.student,
  );
  assertEquals(template.template_content, "print(1)");
  assertEquals(template.version_id, f.result.version_id);
  const versions = await listDomainProblemVersions(
    f.other.slug,
    f.reference,
    f.student,
    1,
    20,
  );
  assertEquals(versions.total, 1);
  assertEquals(Object.hasOwn(versions.items[0], "content"), false);
  await assertRejects(
    () =>
      readDomainProblemTemplate(
        f.other.slug,
        f.reference,
        f.student,
        f.versionId,
      ),
    NotFoundError,
  );
});

Deno.test("域题库读取：副本身份与源引用分离，同域成员读取不受旧 visibility 字段影响", async () => {
  const f = await copied();
  await f.db.update(domainProblemBindings).set({ visibility: "members" }).where(
    eq(domainProblemBindings.id, f.result.binding.id),
  );
  await f.db.update(problems).set({ visibility: "private" }).where(
    eq(problems.id, f.copy.id),
  );
  const read = await readDomainProblem(f.other.slug, f.reference, f.student);
  assertEquals(read.binding_id, f.result.binding.id);
  await assertRejects(
    () => resolveDomainProblem(f.other.slug, `${f.school.slug}:1001`, f.owner),
    NotFoundError,
  );
  const list = await listDomainProblems(f.other.slug, f.student, {
    page: 1,
    limit: 20,
  });
  assertEquals(list.total, 1);
});

Deno.test("域副本：来源下架不撤销副本，本域下架和恢复保留身份及版本", async () => {
  const f = await copied();
  await setDomainProblemBindingState(f.school.slug, "1001", f.owner, 0, {
    disabled: true,
    reason: "来源下架",
  });
  assertEquals(
    (await readDomainProblem(f.other.slug, f.reference, f.student)).content
      .title,
    "教学题",
  );
  await setDomainProblemBindingState(f.other.slug, f.reference, f.owner, 0, {
    disabled: true,
    reason: "本域下架",
  });
  await assertRejects(
    () => readDomainProblem(f.other.slug, f.reference, f.student),
    NotFoundError,
  );
  await setDomainProblemBindingState(f.other.slug, f.reference, f.owner, 1, {
    disabled: false,
    reason: "恢复",
  });
  assertEquals(
    (await resolveDomainProblem(f.other.slug, f.reference, f.owner)).version.id,
    f.result.version_id,
  );
});

Deno.test("域版本策略：题目唯一策略生效，复制策略和来源互不影响，沿革不可变", async () => {
  const f = await copied();
  await setDomainProblemBindingPolicy(f.other.slug, f.reference, f.owner, 0, {
    mode: "exact",
    version_id: f.result.version_id,
  }, "固定副本版本");
  const resolved = await resolveDomainProblem(
    f.other.slug,
    f.reference,
    f.owner,
  );
  assertEquals(resolved.problem.effective_version_mode, "exact");
  assertEquals(resolved.binding.effective_version_mode, "exact");
  assertEquals(
    (await resolveDomainProblem(f.school.slug, "1001", f.owner)).problem
      .effective_version_mode,
    "any",
  );
  const history = await f.db.select().from(problemBindingHistory).where(
    eq(problemBindingHistory.binding_id, f.result.binding.id),
  );
  assert(
    history.some((h) =>
      h.effective_version_mode === "exact" &&
      h.required_version_id === f.result.version_id
    ),
  );
  await assertRejects(
    () =>
      setDomainProblemBindingPolicy(f.other.slug, f.reference, f.owner, 0, {
        mode: "any",
      }, "旧版本"),
    ConflictError,
  );
  await assertRejects(() =>
    setDomainProblemBindingPolicy(f.other.slug, f.reference, f.owner, 1, {
      mode: "exact",
      version_id: f.versionId,
    }, "外域版本")
  );
});

Deno.test("域版本策略：调用方事务回滚同时撤销题目策略、绑定 revision 和沿革", async () => {
  const f = await copied();
  await assertRejects(() =>
    f.db.transaction(async (tx) => {
      await setDomainProblemBindingPolicy(
        f.other.slug,
        f.reference,
        f.owner,
        0,
        { mode: "exact", version_id: f.result.version_id },
        "事务演练",
        tx,
      );
      throw new Error("rollback");
    })
  );
  const resource = await resolveDomainProblem(
    f.other.slug,
    f.reference,
    f.owner,
  );
  assertEquals(resource.problem.effective_version_mode, "any");
  assertEquals(resource.binding.revision, 0);
  assertEquals(
    (await f.db.select().from(problemBindingHistory).where(
      eq(problemBindingHistory.binding_id, f.result.binding.id),
    )).length,
    1,
  );
});

Deno.test("域复制权限：目标可创建不足以导出来源，普通成员不可复制", async () => {
  const f = await assignmentFixture();
  await assertRejects(
    () => importDomainProblem(f.other.slug, `${f.school.slug}:1001`, f.student),
    ForbiddenError,
  );
  await setMemberRoles(f.other.slug, f.owner, f.student, ["editor"]);
  await assertRejects(
    () => importDomainProblem(f.other.slug, `${f.school.slug}:1001`, f.student),
    ForbiddenError,
  );
  assertEquals(
    (await f.db.select().from(problems).where(
      eq(problems.domain_id, f.other.id),
    )).length,
    0,
  );
});

Deno.test("域复制容量：最后一个额度仅一个并发成功，失败不留下半发布身份", async () => {
  const f = await assignmentFixture();
  await f.db.insert(domainLimits).values({ domain_id: f.other.id, problems: 1 })
    .onConflictDoUpdate({
      target: domainLimits.domain_id,
      set: { problems: 1 },
    });
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      importDomainProblem(f.other.slug, `${f.school.slug}:1001`, f.owner)
    ),
  );
  assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
  const failed = results.find((r) =>
    r.status === "rejected"
  ) as PromiseRejectedResult;
  assert(failed.reason instanceof AppError);
  const rows = await f.db.select().from(problems).where(
    eq(problems.domain_id, f.other.id),
  );
  assertEquals(rows.length, 1);
  assert(rows[0].latest_version_id);
  assertEquals(
    (await f.db.select().from(problemVersions).where(
      eq(problemVersions.problem_id, rows[0].id),
    )).length,
    1,
  );
});
