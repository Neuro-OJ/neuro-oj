/**
 * 提交时版本解析测试（Handbook §4.2、§5.4 第 1 步）。
 *
 * 覆盖：显式版本、跨题版本拒绝、竞赛固定版本（客户端覆盖 → 409）、
 * 已版本化题目缺版本 → VERSION_REQUIRED（不静默绑定最新版）、
 * 迁移期未发布题目 → legacy_unknown、版本内容对提交模式/语言的校验。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  contestProblems,
  contests,
  problems,
  problemVersions,
  submissions,
} from "../../../../shared/db/schema.ts";
import {
  assertVersionAcceptsSubmission,
  resolveSubmissionVersion,
} from "../../services/versioning/submission-version.ts";
import { createSubmission } from "../../index.ts";
import type { ProblemContentV1 } from "../../../catalog/index.ts";

const now = new Date().toISOString();

async function seedProblem(
  id: string,
  number: number,
  options: { publish?: boolean; judgeType?: "dual" | "oi" } = {},
): Promise<void> {
  await getDb().insert(problems).values({
    id,
    title: id,
    description: "d",
    type: "P",
    number,
    owner_id: "0",
    difficulty: "easy",
    judge_type: options.judgeType ?? "dual",
    runtime_config: options.judgeType === "oi"
      ? {
        backend: "native",
        languages: ["c"],
        time_limit_ms: 1000,
        memory_limit_mb: 256,
        checker: { type: "default" },
        subtasks: [],
      }
      : {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 60000,
          memory_limit_mb: 512,
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 60000,
          memory_limit_mb: 512,
        },
      },
    created_at: now,
    updated_at: now,
  });
  if (options.publish === false) return;
  await getDb().insert(problemVersions).values({
    id: `${id}-v1`,
    problem_id: id,
    version: 1,
    schema_version: 1,
    origin: "published",
    content: {
      kind: options.judgeType === "oi" ? "oi" : "ai",
      title: id,
      description: "d",
      samples: [],
      ...(options.judgeType === "oi"
        ? {
          runtime_config: {
            backend: "native",
            languages: ["c"],
            time_limit_ms: 1000,
            memory_limit_mb: 256,
            checker: { type: "default" },
            subtasks: [],
          },
        }
        : {
          submission_mode: "code",
          runtime_config: {
            evaluator: {
              image: "noj-evaluator-python",
              command: "python3 /workspace/evaluate.py",
              time_limit_ms: 60000,
              memory_limit_mb: 512,
            },
            solution: {
              image: "noj-solution-python",
              call_timeout_ms: 60000,
              memory_limit_mb: 512,
            },
          },
          template_content: "",
          artifact_max_size_mb: null,
          llm_config: null,
        }),
    },
    content_sha256: "hash-" + id,
    published_at: now,
  });
  await getDb().update(problems).set({ latest_version_id: `${id}-v1` }).where(
    eq(problems.id, id),
  );
}

Deno.test("submission version: 显式版本被采用并标记 known", async () => {
  await seedProblem("sv-p1", 980001);
  const resolved = await resolveSubmissionVersion("sv-p1", {
    requestedVersionId: "sv-p1-v1",
  });
  assertEquals(resolved.kind, "known");
  if (resolved.kind === "known") {
    assertEquals(resolved.version.version_id, "sv-p1-v1");
    assertEquals(resolved.version.version, 1);
    assertEquals(resolved.version.is_latest, true);
    assertEquals(resolved.version.source, "requested");
  }
});

Deno.test("submission version: 跨题版本与未发布版本一律 404", async () => {
  await seedProblem("sv-p2", 980002);
  await seedProblem("sv-p3", 980003);
  await assertRejects(
    () => resolveSubmissionVersion("sv-p2", { requestedVersionId: "sv-p3-v1" }),
    Error,
    "版本不存在或未发布",
  );
  await assertRejects(
    () => resolveSubmissionVersion("sv-p2", { requestedVersionId: "ghost" }),
    Error,
    "版本不存在或未发布",
  );
});

Deno.test("submission version: 已版本化题目缺版本 → VERSION_REQUIRED", async () => {
  await seedProblem("sv-p4", 980004);
  await assertRejects(
    () => resolveSubmissionVersion("sv-p4", {}),
    Error,
    "必须携带 version_id",
  );
});

Deno.test("submission version: 迁移期未发布题目 → legacy_unknown", async () => {
  await seedProblem("sv-p5", 980005, { publish: false });
  const resolved = await resolveSubmissionVersion("sv-p5", {});
  assertEquals(resolved.kind, "legacy_unknown");
});

Deno.test("submission version: 竞赛使用固定版本，客户端覆盖 → 409", async () => {
  await seedProblem("sv-p6", 980006);
  await getDb().insert(contests).values({
    id: "sv-c6",
    public_id: "ct-sv6",
    title: "c",
    start_time: "2026-01-01T00:00:00.000Z",
    end_time: "2026-12-31T00:00:00.000Z",
    type: "kaggle",
    kind: "public",
    is_public: true,
    created_at: now,
    updated_at: now,
  });
  await getDb().insert(contestProblems).values({
    contest_id: "sv-c6",
    problem_id: "sv-p6",
    label: "A",
    score: 100,
    sort_order: 0,
    pinned_version_id: "sv-p6-v1",
  });

  // 未携带版本 → 使用固定版本
  const resolved = await resolveSubmissionVersion("sv-p6", {
    contestId: "sv-c6",
  });
  assertEquals(resolved.kind, "known");
  if (resolved.kind === "known") {
    assertEquals(resolved.version.version_id, "sv-p6-v1");
    assertEquals(resolved.version.source, "contest");
  }

  // 客户端携带同一版本 → 允许
  const same = await resolveSubmissionVersion("sv-p6", {
    contestId: "sv-c6",
    requestedVersionId: "sv-p6-v1",
  });
  assertEquals(same.kind, "known");

  // 客户端覆盖为别的版本 → 409
  await assertRejects(
    () =>
      resolveSubmissionVersion("sv-p6", {
        contestId: "sv-c6",
        requestedVersionId: "other-version",
      }),
    Error,
    "竞赛题目版本已变更",
  );
});

Deno.test("submission version: 版本内容校验提交模式与语言", async () => {
  await seedProblem("sv-p7", 980007, { judgeType: "oi" });
  const oi = await resolveSubmissionVersion("sv-p7", {
    requestedVersionId: "sv-p7-v1",
  });
  assertEquals(oi.kind, "known");
  if (oi.kind === "known") {
    // OI 版本仅允许 c/cc
    assertVersionAcceptsSubmission(oi.version.content, {
      language: "c",
      submissionMode: "code",
    });
    await assertRejects(
      () => {
        try {
          assertVersionAcceptsSubmission(oi.version.content, {
            language: "python",
            submissionMode: "code",
          });
        } catch (error) {
          return Promise.reject(error);
        }
        return Promise.resolve();
      },
      Error,
      "不支持该语言",
    );
  }

  const ai = {
    kind: "ai",
    title: "t",
    description: "d",
    samples: [],
    submission_mode: "artifact",
    runtime_config: {
      evaluator: {
        image: "i",
        command: "c",
        time_limit_ms: 1,
        memory_limit_mb: 1,
      },
      solution: { image: "s", call_timeout_ms: 1, memory_limit_mb: 1 },
    },
    template_content: "",
    artifact_max_size_mb: null,
    llm_config: null,
  } as unknown as ProblemContentV1;
  await assertRejects(
    () => {
      try {
        assertVersionAcceptsSubmission(ai, {
          language: "python",
          submissionMode: "code",
        });
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.resolve();
    },
    Error,
    "提交模式",
  );
});

Deno.test("submission version: createSubmission 落库提交时版本", async () => {
  await seedProblem("sv-p8", 980008);
  // 评测队列不可用时 createSubmission 会抛 500，但提交行已落库——这里只断言版本绑定
  await createSubmission("0", {
    problem_id: "sv-p8",
    language: "python",
    code: "print(1)",
    version_id: "sv-p8-v1",
  }).catch(() => {/* 评测队列不可用属预期：版本绑定已落库 */});

  const rows = await getDb().select().from(submissions).where(
    eq(submissions.problem_id, "sv-p8"),
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].submitted_version_id, "sv-p8-v1");
  assertEquals(rows[0].version_origin, "known");
});
