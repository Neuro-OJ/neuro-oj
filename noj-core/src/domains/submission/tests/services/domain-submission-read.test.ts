import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import { submissions } from "../../../../shared/db/schema.ts";
import { setDomainProblemSharing } from "../../../catalog/index.ts";
import { removeDomainMember } from "../../../workspace/index.ts";
import {
  createDomainSubmission,
  getDomainSubmission,
  listDomainSubmissions,
} from "../../index.ts";
import { fixture, withQueue } from "../_domain-execution-fixture.ts";
import { saveV2ResultForTest } from "../_versioning-fixtures.ts";

Deno.test({
  name: "域提交读取：错误域与同学被拒，撤销保留原代码成绩但删除源输出",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await withQueue(async () => {
      const created = await createDomainSubmission(f.a.slug, f.ref, f.student, {
        language: "python3",
        code: "print(42)",
        version_id: f.v2,
      });
      await saveV2ResultForTest({
        submission_id: created.id,
        status: "finished",
        score: 7000,
        output: "hidden evaluator output",
        details: { arbitrary: "source data" },
      });
      const detail = await getDomainSubmission(f.a.slug, created.id, f.student);
      assertEquals(detail.domain_id, f.a.id);
      assertEquals(detail.code, "print(42)");
      assertEquals(detail.resource_available, true);
      await assertRejects(
        () => getDomainSubmission(f.b.slug, created.id, f.student),
        NotFoundError,
      );
      await assertRejects(
        () => getDomainSubmission(f.a.slug, created.id, f.outsider),
        NotFoundError,
      );
      assertEquals(
        (await listDomainSubmissions(f.a.slug, f.student, {
          page: 1,
          perPage: 20,
        })).total,
        1,
      );
      assertEquals(
        (await listDomainSubmissions(f.b.slug, f.student, {
          page: 1,
          perPage: 20,
        })).total,
        0,
      );
      await setDomainProblemSharing(f.source.slug, "1001", f.owner, {
        expectedRevision: 1,
        enabled: false,
        scope: "all",
        targetDomainIds: [],
      });
      const withdrawn = await getDomainSubmission(
        f.a.slug,
        created.id,
        f.student,
      );
      assertEquals(withdrawn.code, "print(42)");
      assertEquals(withdrawn.resource_available, false);
      assertEquals(withdrawn.result, {
        status: "finished",
        score: 7000,
        time_ms: null,
        memory_kb: null,
      });
      assertEquals(Object.hasOwn(withdrawn, "attempts"), false);
      assertEquals(
        JSON.stringify(withdrawn).includes("hidden evaluator"),
        false,
      );
      assertEquals(JSON.stringify(withdrawn).includes("source data"), false);
      assertEquals(
        (await listDomainSubmissions(f.a.slug, f.student, {
          page: 1,
          perPage: 20,
        })).data[0].problem.title,
        "资源不可用",
      );
      await removeDomainMember(f.a.slug, f.owner, f.student);
      await assertRejects(
        () => getDomainSubmission(f.a.slug, created.id, f.student),
        NotFoundError,
      );
      const [stored] = await f.db.select().from(submissions).where(
        eq(submissions.id, created.id),
      );
      assertEquals(stored.code, "print(42)");
    });
  },
});
