import { assertEquals } from "jsr:@std/assert@^1";
import {
  contestParticipants,
  contestProblems,
  contests,
} from "../../../../shared/db/schema.ts";
import {
  createDomainSubmission,
  getDomainSubmission,
  listDomainSubmissions,
} from "../../index.ts";
import { fixture, withQueue } from "../_domain-execution-fixture.ts";
import { saveV2ResultForTest } from "../_versioning-fixtures.ts";

for (const type of ["oi", "ioi", "ioi_strict", "acm"] as const) {
  Deno.test({
    name: `赛制域读取 ${type}：列表正常返回，详情不重新添加允许列表外的输出`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const f = await fixture("oi"),
        id = crypto.randomUUID(),
        now = new Date().toISOString();
      await f.db.insert(contests).values({
        id,
        domain_id: f.a.id,
        title: "域读取回归",
        type,
        kind: "invite",
        created_by: f.owner,
        start_time: new Date(Date.now() - 60000).toISOString(),
        end_time: new Date(Date.now() + 60000).toISOString(),
        created_at: now,
        updated_at: now,
      });
      await f.db.insert(contestProblems).values({
        contest_id: id,
        domain_id: f.a.id,
        domain_problem_binding_id: f.bindingA.id,
        problem_id: f.problemId,
        pinned_version_id: f.v2,
        label: "A",
        score: 10000,
      });
      await f.db.insert(contestParticipants).values({
        contest_id: id,
        user_id: f.student,
        registered_at: now,
      });
      await withQueue(async () => {
        const created = await createDomainSubmission(f.a.slug, "A", f.student, {
          version_id: f.v2,
          language: "cc",
          code: "int main() { return 0; }",
        }, id);
        await saveV2ResultForTest({
          submission_id: created.id,
          status: "finished",
          score: 2000,
          output: "raw evaluator data",
          details: { oi: { backend: "native", verdict: "WA", cases: [] } },
        });
        const list = await listDomainSubmissions(f.a.slug, f.student, {
          page: 1,
          perPage: 20,
          contestId: id,
        });
        assertEquals(list.total, 1);
        assertEquals(list.data[0].problem.title, "共享题");
        const detail = await getDomainSubmission(
          f.a.slug,
          created.id,
          f.student,
        );
        assertEquals(
          detail.result_visibility,
          type === "oi" ? "hidden" : type === "ioi" ? "cases" : "summary",
        );
        if (type === "oi") {
          assertEquals(Object.hasOwn(detail, "result"), false);
          assertEquals(Object.hasOwn(list.data[0], "result"), false);
        } else {
          const result = detail.result as Record<string, unknown>;
          assertEquals(Object.hasOwn(result, "output"), false);
          assertEquals(Object.hasOwn(result, "output_truncated"), false);
          assertEquals(result.score, 2000);
        }
        assertEquals(
          JSON.stringify(detail).includes("raw evaluator data"),
          false,
        );
      });
    },
  });
}
