import { type Context, Hono } from "hono";
import { educationWriteRateLimit } from "./write-rate-limit.ts";
import {
  type AssignmentMatrixOptions,
  getAssignmentMatrix,
  getMyAssignmentProgress,
  type ProgressScope,
} from "../services/progress-read.ts";
import { exportAssignmentMatrixCsv } from "../services/matrix-csv.ts";
import {
  type ContestRemediationInput,
  type ContestRemediationRule,
  createContestRemediation,
  previewContestRemediation,
} from "../services/contest-remediation.ts";
import {
  type AssignmentRemediationInput,
  createAssignmentRemediation,
  previewAssignmentRemediation,
} from "../services/assignment-remediation.ts";
import { getAssignmentHistory } from "../services/history-read.ts";
import { getTrainingComparison } from "../services/training-comparison.ts";
import { listAssignmentItemSubmissions } from "../services/submission-evidence.ts";
import {
  type AssignmentCopyInput,
  copyAssignment,
} from "../services/assignment-copy.ts";
import { authMiddleware } from "../../access/identity/middleware/auth.ts";
import { type AuthEnv } from "../../../shared/http/hono-env.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
import {
  type AssignmentDraftInput,
  createAssignment,
  getAssignment,
  listAssignments,
  updateAssignment,
} from "../services/assignments.ts";
import {
  changeAssignmentLifecycle,
  publishAssignment,
  scheduleAssignment,
} from "../services/assignment-lifecycle.ts";

const router = new Hono<AuthEnv>();
router.get(
  "/domains/:slug/assignments/:id/students/:userId/training-comparison",
  authMiddleware,
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await getTrainingComparison(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.req.param("userId")!,
        c.var.userId,
        {
          before_start: c.req.query("before_start") ?? "",
          before_end: c.req.query("before_end") ?? "",
          after_start: c.req.query("after_start") ?? "",
          after_end: c.req.query("after_end") ?? "",
        },
      ),
    });
  },
);
router.use("/domains/:slug/assignments/*", authMiddleware, async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

function revision(value: string | undefined) {
  if (!value) return null;
  const match = /^"?([0-9]+)"?$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw new BadRequestError("If-Match 必须是作业 revision");
  }
  return Number(match[1]);
}

router.get("/domains/:slug/classrooms/:id/assignments", async (c) => {
  const { page } = parsePagination(c, { defaultPerPage: 50, maxPerPage: 50 });
  return c.json({
    data: await listAssignments(
      c.req.param("slug"),
      c.req.param("id"),
      c.var.userId,
      page,
    ),
    page,
    per_page: 50,
  });
});
router.post(
  "/domains/:slug/classrooms/:id/assignments",
  educationWriteRateLimit,
  async (c) => {
    const input = await parseJsonBody<AssignmentDraftInput>(c);
    assertObjectBody(input);
    return c.json({
      data: await createAssignment(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        input,
      ),
    }, 201);
  },
);
router.get("/domains/:slug/assignments/:id", async (c) =>
  c.json({
    data: await getAssignment(
      c.req.param("slug"),
      c.req.param("id"),
      c.var.userId,
    ),
  }));
router.patch(
  "/domains/:slug/assignments/:id",
  educationWriteRateLimit,
  async (c) => {
    const input = await parseJsonBody<AssignmentDraftInput>(c);
    assertObjectBody(input);
    return c.json({
      data: await updateAssignment(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        revision(c.req.header("If-Match")),
        input,
      ),
    });
  },
);
router.post(
  "/domains/:slug/assignments/:id/publish",
  educationWriteRateLimit,
  async (c) =>
    c.json({
      data: await publishAssignment(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        revision(c.req.header("If-Match")),
        c.req.header("Idempotency-Key") ?? "",
      ),
    }),
);
router.post(
  "/domains/:slug/assignments/:id/schedule",
  educationWriteRateLimit,
  async (c) => {
    const input = await parseJsonBody<{ publish_at: string }>(c);
    assertObjectBody(input);
    return c.json({
      data: await scheduleAssignment(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        revision(c.req.header("If-Match")),
        input.publish_at,
      ),
    });
  },
);
for (const action of ["extend", "end", "archive"] as const) {
  router.post(
    `/domains/:slug/assignments/:id/${action}`,
    educationWriteRateLimit,
    async (c) => {
      const input = await parseJsonBody<
        { reason: string; deadline_at?: string | null }
      >(c);
      assertObjectBody(input);
      return c.json({
        data: await changeAssignmentLifecycle(
          c.req.param("slug"),
          c.req.param("id"),
          c.var.userId,
          revision(c.req.header("If-Match")),
          { action, reason: input.reason, deadline_at: input.deadline_at },
        ),
      });
    },
  );
}

/** 作业准备路由，与班级路由一起等待完整隔离门禁后开放。 */
router.post(
  "/domains/:slug/assignments/:id/copy",
  educationWriteRateLimit,
  async (c) => {
    const input = await parseJsonBody<AssignmentCopyInput>(c);
    assertObjectBody(input);
    return c.json({
      data: await copyAssignment(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        revision(c.req.header("If-Match")),
        c.req.header("Idempotency-Key") ?? "",
        input,
      ),
    }, 201);
  },
);

router.post(
  "/domains/:slug/assignments/:id/remediation-preview",
  educationWriteRateLimit,
  async (c) => {
    const input = await parseJsonBody<{ scope?: ProgressScope }>(c);
    assertObjectBody(input);
    return c.json({
      data: await previewAssignmentRemediation(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        input.scope,
      ),
    });
  },
);
router.post(
  "/domains/:slug/assignments/:id/remediation",
  educationWriteRateLimit,
  async (c) => {
    const input = await parseJsonBody<AssignmentRemediationInput>(c);
    assertObjectBody(input);
    return c.json({
      data: await createAssignmentRemediation(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        revision(c.req.header("If-Match")),
        c.req.header("Idempotency-Key") ?? "",
        input,
      ),
    }, 201);
  },
);

router.post(
  "/domains/:slug/classrooms/:id/contest-remediation-preview",
  educationWriteRateLimit,
  async (c) => {
    const input = await parseJsonBody<ContestRemediationRule>(c);
    assertObjectBody(input);
    return c.json({
      data: await previewContestRemediation(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        input,
      ),
    });
  },
);
router.post(
  "/domains/:slug/classrooms/:id/contest-remediation",
  educationWriteRateLimit,
  async (c) => {
    const input = await parseJsonBody<ContestRemediationInput>(c);
    assertObjectBody(input);
    return c.json({
      data: await createContestRemediation(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        revision(c.req.header("If-Match")),
        c.req.header("Idempotency-Key") ?? "",
        input,
      ),
    }, 201);
  },
);

/** 作业准备路由，与班级路由一起等待完整隔离门禁后开放。 */
router.get(
  "/domains/:slug/assignments/:id/progress",
  async (c) =>
    c.json({
      data: await getMyAssignmentProgress(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        c.req.query("scope") as ProgressScope | undefined,
      ),
    }),
);
router.get("/domains/:slug/assignments/:id/matrix", async (c) => {
  const { page } = parsePagination(c, { defaultPerPage: 50, maxPerPage: 50 });
  return c.json({
    data: await getAssignmentMatrix(
      c.req.param("slug"),
      c.req.param("id"),
      c.var.userId,
      { ...matrixOptions(c), page },
    ),
  });
});
router.get(
  "/domains/:slug/assignments/:id/students/:userId/items/:itemId/submissions",
  async (c) => {
    const { page } = parsePagination(c, { defaultPerPage: 25, maxPerPage: 25 });
    return c.json({
      data: await listAssignmentItemSubmissions(
        c.req.param("slug"),
        c.req.param("id"),
        c.req.param("userId"),
        c.req.param("itemId"),
        c.var.userId,
        { page, scope: c.req.query("scope") as ProgressScope | undefined },
      ),
    });
  },
);
router.get("/domains/:slug/assignments/:id/history", async (c) => {
  const { page } = parsePagination(c, { defaultPerPage: 50, maxPerPage: 50 });
  return c.json({
    data: await getAssignmentHistory(
      c.req.param("slug"),
      c.req.param("id"),
      c.var.userId,
      page,
    ),
  });
});

function matrixOptions(
  c: Context<AuthEnv>,
): Omit<AssignmentMatrixOptions, "page"> {
  return {
    scope: c.req.query("scope") as AssignmentMatrixOptions["scope"],
    recipients: c.req.query(
      "recipients",
    ) as AssignmentMatrixOptions["recipients"],
    search: c.req.query("search"),
    student_id: c.req.query("student_id"),
    item_id: c.req.query("item_id"),
    status: c.req.query("status") as AssignmentMatrixOptions["status"],
    verdict: c.req.query("verdict") as AssignmentMatrixOptions["verdict"],
  };
}

router.get("/domains/:slug/assignments/:id/matrix.csv", async (c) => {
  const iterator = await exportAssignmentMatrixCsv(
    c.req.param("slug"),
    c.req.param("id"),
    c.var.userId,
    matrixOptions(c),
  );
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      await iterator.return();
    },
  });
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header(
    "Content-Disposition",
    `attachment; filename="assignment-${
      encodeURIComponent(c.req.param("id"))
    }.csv"`,
  );
  return c.body(stream);
});

/** 作业准备路由，与班级路由一起等待完整隔离门禁后开放。 */
export const assignmentRouter = router;
