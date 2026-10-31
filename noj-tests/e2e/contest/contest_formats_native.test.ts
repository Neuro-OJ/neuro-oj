/** 五赛制真实 HTTP / Judge 回归，不向数据库写入提交或评测成绩。 */
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@^1.0.13";
import {
  api,
  BASE_URL,
  getAdminToken,
  isE2E,
  registerUser,
  TEST_PASSWORD,
} from "../helper.ts";

const nativeEnabled = (Deno.env.get("E2E_JUDGE_RESOURCE_POOLS") ?? "ai").split(
  ",",
).includes("oi-native");
const suffix = Date.now().toString(36), slug = `format-${suffix}`;
const root = `/api/v1/domains/${slug}`;
type Format = "kaggle" | "oi" | "ioi" | "ioi_strict" | "acm";
interface Problem {
  id: string;
  number: number;
  version: string;
}
interface Contest {
  id: string;
  revision: number;
  start_time: string;
  end_time: string;
}
interface Row {
  user_id: string;
  rank: number;
  total_score: number;
  solved: number;
  penalty_ms: number;
  pending: boolean;
  problem_scores: {
    best_score: number | null;
    pending: boolean;
    submission_id?: string;
  }[];
}
let admin = "", participant = "", peer = "", participantId = "";
let aiProblem: Problem, oiProblem: Problem, objective: Problem, frozen: Contest;
let frozenAccepted = "";

function formatTest(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `[e2e/contest-formats-native] ${name}`,
    ignore: !isE2E || !nativeEnabled,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}
async function call(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const result = await api(method, path, { token, body, headers });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${method} ${path}: ${JSON.stringify(result)}`);
  }
  return result.body;
}
async function join(token: string, email: string) {
  const invited = await call("POST", `${root}/invitations`, admin, {
    email,
  }) as { data: { token: string } };
  await call("POST", "/api/v1/domain-invitations/accept", token, {
    token: invited.data.token,
  });
}
async function bundle(kind: "ai" | "oi"): Promise<Problem> {
  const directory = await Deno.makeTempDir();
  try {
    const runtime = kind === "oi"
      ? {
        backend: "native",
        scoring_version: 2,
        languages: ["cc"],
        time_limit_ms: 1000,
        memory_limit_mb: 256,
        checker: { type: "default" },
        subtasks: [
          {
            id: "small",
            score: 20,
            cases: [{
              id: "case-1",
              input: "secret-cases/1.in",
              output: "secret-cases/1.out",
            }],
          },
          {
            id: "large",
            score: 80,
            cases: [{
              id: "case-2",
              input: "secret-cases/2.in",
              output: "secret-cases/2.out",
            }],
          },
        ],
      }
      : {
        evaluator: {
          image: "noj-evaluator-python",
          time_limit_ms: 10000,
          memory_limit_mb: 512,
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 5000,
          memory_limit_mb: 256,
        },
      };
    await Deno.writeTextFile(
      `${directory}/problem.json`,
      JSON.stringify({
        format_version: 2,
        title: `${kind} 赛制夹具 ${suffix}`,
        difficulty: "easy",
        judge_type: kind === "oi" ? "oi" : "dual",
        runtime_config: runtime,
      }),
    );
    await Deno.writeTextFile(
      `${directory}/statement.md`,
      kind === "oi"
        ? "# 原样输出输入整数\n两个子任务分别20分、80分。"
        : "# 返回100或20\n按返回值计分。",
    );
    if (kind === "oi") {
      await Deno.mkdir(`${directory}/secret-cases`);
      for (const number of [1, 2]) {
        await Deno.writeTextFile(
          `${directory}/secret-cases/${number}.in`,
          `${number}\n`,
        );
        await Deno.writeTextFile(
          `${directory}/secret-cases/${number}.out`,
          `${number}\n`,
        );
      }
    } else {
      await Deno.writeTextFile(
        `${directory}/evaluate.py`,
        `from noj_evaluator_sdk import SolutionRunner, result
runner = SolutionRunner()
try:
    score = runner.call("solve")
    if score == 100:
        result.accept(score=100)
    else:
        result.wrong_answer(score=20)
finally:
    runner.close()
`,
      );
    }
    const packed = await new Deno.Command("zip", {
      args: ["-r", `${directory}/bundle.zip`, "."],
      cwd: directory,
    }).output();
    assertEquals(packed.code, 0);
    const bytes = await Deno.readFile(`${directory}/bundle.zip`),
      body = new FormData();
    body.set(
      "file",
      new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" }),
      `${kind}.zip`,
    );
    const response = await fetch(`${BASE_URL}${root}/problems/import-bundle`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}` },
      body,
    });
    const imported = await response.json();
    assertEquals(response.status, 201, JSON.stringify(imported));
    const problem = imported.data as {
      problem_id: string;
      number: number;
      draft_revision: number;
    };
    const published = await call(
      "POST",
      `${root}/problems/${problem.number}/publish`,
      admin,
      { change_note: "赛制真实评测V1" },
      { "If-Match": String(problem.draft_revision) },
    ) as { version_id: string };
    return {
      id: problem.problem_id,
      number: problem.number,
      version: published.version_id,
    };
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}
function contestInput(
  type: Format,
  problem: Problem,
  options: Record<string, unknown> = {},
) {
  const now = Date.now();
  return {
    title: `${type} HTTP ${suffix}`,
    type,
    start_time: new Date(now - 120000).toISOString(),
    end_time: new Date(now + 600000).toISOString(),
    is_public: true,
    config: {},
    problems: [{
      problem_id: problem.id,
      sort_order: 0,
      label: "A",
      score: 10000,
    }],
    ...(type === "acm" ? { freeze_duration_seconds: 0 } : {}),
    ...options,
  };
}
async function createContest(
  type: Format,
  problem: Problem,
  options: Record<string, unknown> = {},
) {
  const created = await call(
    "POST",
    `${root}/contests`,
    admin,
    contestInput(type, problem, options),
  ) as { data: Contest };
  for (const token of [participant, peer]) {
    await call(
      "POST",
      `${root}/contests/${created.data.id}/register`,
      token,
      {},
    );
  }
  return created.data;
}
const ac =
  "#include <iostream>\nint main(){int x;std::cin>>x;std::cout<<x<<'\\n';}";
const partial = "#include <iostream>\nint main(){std::cout<<1<<'\\n';}";
const wrong = "#include <iostream>\nint main(){std::cout<<0<<'\\n';}";
const ce = "int main( { syntax_error }";
const aiCode = (score: number) =>
  `from noj_solution_sdk import register\n@register\ndef solve(): return ${score}\n`;

async function submit(
  contest: Contest,
  problem: Problem,
  code: string,
  language = "cc",
  token = participant,
) {
  const accepted = await call(
    "POST",
    `${root}/contests/${contest.id}/problems/A/submissions`,
    token,
    {
      version_id: problem.version,
      language,
      code,
    },
  ) as { data: { id: string } };
  for (let attempt = 0; attempt < 90; attempt++) {
    const response = await call(
      "GET",
      `${root}/submissions/${accepted.data.id}`,
      admin,
    ) as {
      data: {
        id: string;
        status: string;
        created_at: string;
        result: { score: number; verdict?: string; details?: unknown };
      };
    };
    if (response.data.status === "error") {
      throw new Error(`真实Judge平台错误 ${JSON.stringify(response.data)}`);
    }
    if (response.data.status === "finished") return response.data;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`真实Judge评测超时 ${accepted.data.id}`);
}
async function ranking(contest: Contest, token = participant) {
  return await call("GET", `${root}/contests/${contest.id}/ranking`, token) as {
    data: Row[];
    view: string;
    snapshot?: { version: number };
  };
}
async function result(id: string) {
  return (await call("GET", `${root}/submissions/${id}`, participant) as {
    data: Record<string, unknown>;
  }).data;
}
/** 验证允许列表在真实 evaluator 结果上生效，递归排除数据与原始诊断字段。 */
function noData(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    assertFalse(
      [
        "input",
        "output",
        "expected",
        "stdout",
        "stderr",
        "path",
        "data_path",
        "diagnostics",
      ].includes(key),
      key,
    );
    noData(nested);
  }
  assertFalse(JSON.stringify(value).includes("secret-cases/"));
}

formatTest("Setup：私有域、两名参赛者与真实AI/OI/客观题版本", async () => {
  admin = await getAdminToken();
  participant = await registerUser(
    `format_a_${suffix}`,
    `format_a_${suffix}@test.com`,
    TEST_PASSWORD,
  );
  peer = await registerUser(
    `format_b_${suffix}`,
    `format_b_${suffix}@test.com`,
    TEST_PASSWORD,
  );
  participantId = ((await call("GET", "/api/v1/auth/me", participant)) as {
    data: { id: string };
  }).data.id;
  await call("POST", "/api/v1/domains", admin, {
    slug,
    name: slug,
    preset: "team",
  });
  await join(participant, `format_a_${suffix}@test.com`);
  await join(peer, `format_b_${suffix}@test.com`);
  aiProblem = await bundle("ai");
  oiProblem = await bundle("oi");
  const created = await call("POST", `${root}/problems`, admin, {
    title: `客观题 ${suffix}`,
    description: "选择A",
    is_objective: true,
  }) as { problem_id: string; number: number; draft_revision: number };
  const saved = await call(
    "PUT",
    `${root}/problems/${created.number}/draft`,
    admin,
    {
      content: {
        kind: "objective",
        title: `客观题 ${suffix}`,
        description: "选择A",
        samples: [],
        questions: [{
          key: "answer-one",
          sort_order: 0,
          type: "single",
          prompt: "选择A",
          options: [{ key: "A", text: "A" }, { key: "B", text: "B" }],
          answer: ["A"],
          explanation: "A",
        }],
      },
    },
    { "If-Match": String(created.draft_revision) },
  ) as { revision: number };
  const published = await call(
    "POST",
    `${root}/problems/${created.number}/publish`,
    admin,
    {},
    { "If-Match": String(saved.revision) },
  ) as { version_id: string };
  objective = {
    id: created.problem_id,
    number: created.number,
    version: published.version_id,
  };
});

formatTest("题型矩阵在创建和赛前编辑时校验，开赛后计分规则不可改", async () => {
  for (
    const [type, problem] of [["kaggle", oiProblem], ["ioi", aiProblem], [
      "ioi_strict",
      objective,
    ], ["acm", objective]] as const
  ) {
    const rejected = await api("POST", `${root}/contests`, {
      token: admin,
      body: contestInput(type, problem),
    });
    assertEquals(rejected.status, 400);
  }
  const now = Date.now();
  const future = await call(
    "POST",
    `${root}/contests`,
    admin,
    contestInput("ioi", oiProblem, {
      start_time: new Date(now + 300000).toISOString(),
    }),
  ) as { data: Contest };
  const invalidEdit = await api("PATCH", `${root}/contests/${future.data.id}`, {
    token: admin,
    headers: { "If-Match": String(future.data.revision) },
    body: {
      problems: [{
        problem_id: aiProblem.id,
        sort_order: 0,
        label: "A",
        score: 10000,
      }],
    },
  });
  assertEquals(invalidEdit.status, 400);
});

formatTest("Kaggle：先100再20，采用最高分并保持本人榜", async () => {
  const contest = await createContest("kaggle", aiProblem);
  assertEquals(
    (await submit(contest, aiProblem, aiCode(100), "python3")).result.score,
    10000,
  );
  assertEquals(
    (await submit(contest, aiProblem, aiCode(20), "python3")).result.score,
    2000,
  );
  const board = await ranking(contest);
  assertEquals(board.data.length, 1);
  assertEquals(board.data[0].total_score, 10000);
});

for (const type of ["oi", "ioi", "ioi_strict"] as const) {
  formatTest(`${type}：最后提交20分与CE零分，真实结果按赛制裁剪`, async () => {
    const contest = await createContest(type, oiProblem);
    assertEquals((await submit(contest, oiProblem, ac)).result.score, 10000);
    const last = await submit(contest, oiProblem, partial);
    assertEquals(last.result.score, 2000);
    const organizer = await ranking(contest, admin);
    assertEquals(
      organizer.data.find((row) => row.user_id === participantId)!.total_score,
      2000,
    );
    assertEquals(
      organizer.data.find((row) => row.user_id === participantId)!
        .problem_scores[0].submission_id,
      last.id,
    );
    const own = await result(last.id);
    if (type === "oi") {
      assertEquals(own.status, "submitted");
      assertEquals(own.result_visibility, "hidden");
      for (
        const key of [
          "result",
          "score",
          "verdict",
          "time_ms",
          "memory_kb",
          "latest_attempt",
          "effective_attempt",
          "attempts",
          "progress",
        ]
      ) assertFalse(key in own, key);
      assertEquals(
        (await api("GET", `${root}/contests/${contest.id}/ranking`, {
          token: participant,
        })).status,
        404,
      );
      const list = await call(
        "GET",
        `${root}/submissions?contest_id=${contest.id}`,
        participant,
      ) as { data: Record<string, unknown>[] };
      assertEquals(list.data.length, 2);
      for (const row of list.data) {
        assertFalse("result" in row);
        assertFalse("score" in row);
        assertEquals(row.status, "submitted");
      }
      const bypass = await api("POST", `${root}/submissions`, {
        token: participant,
        body: {
          problem_ref: String(oiProblem.number),
          version_id: oiProblem.version,
          language: "cc",
          code: ac,
        },
      });
      assertEquals(bypass.status, 403);
    } else {
      const summary = own.result as {
        score: number;
        details: { oi: { subtasks?: { cases: unknown[] }[] } };
      };
      assertEquals(summary.score, 2000);
      noData(summary);
      assertEquals(own.result_visibility, type === "ioi" ? "cases" : "summary");
      if (type === "ioi") {
        assertEquals(summary.details.oi.subtasks!.length, 2);
        assertEquals(summary.details.oi.subtasks![0].cases.length, 1);
        const allowed = new Set([
          "score",
          "max_score",
          "case_id",
          "id",
          "verdict",
          "status",
          "time_ms",
          "cpu_time_ms",
          "wall_time_ms",
          "equivalent_time_ms",
          "fuel_consumed",
          "fuel_budget",
          "termination_reason",
          "memory_kb",
          "hidden",
          "visibility",
        ]);
        for (const subtask of summary.details.oi.subtasks!) {
          for (const testCase of subtask.cases) {
            for (
              const key of Object.keys(testCase as Record<string, unknown>)
            ) {
              assert(allowed.has(key), `IOI测试点字段不在允许列表：${key}`);
            }
          }
        }
        await submit(contest, oiProblem, partial, "cc", peer);
        const tied = await ranking(contest);
        assertEquals(tied.data.length, 2);
        assertEquals(tied.data.map((row) => row.rank), [1, 1]);
      } else {
        assertFalse("subtasks" in summary.details.oi);
        assertFalse("cases" in summary.details.oi);
      }
    }
    const failed = await submit(contest, oiProblem, ce);
    assertEquals(failed.result.score, 0);
    assertEquals(
      (await ranking(contest, admin)).data.find((row) =>
        row.user_id === participantId
      )!.total_score,
      0,
    );
    const locked = await api("PATCH", `${root}/contests/${contest.id}`, {
      token: admin,
      headers: { "If-Match": String(contest.revision) },
      body: { type: "acm" },
    });
    assertEquals(locked.status, 409);
  });
}

formatTest("客观题一次正式交卷，Kaggle/OI原百分分数不乘题目满分", async () => {
  for (const type of ["kaggle", "oi"] as const) {
    const contest = await createContest(type, objective, {
      problems: [{
        problem_id: objective.id,
        sort_order: 0,
        label: "A",
        score: 50000,
      }],
    });
    const path =
      `${root}/contests/${contest.id}/problems/A/objective-submissions`;
    const body = {
      version_id: objective.version,
      answers: { "answer-one": ["A"] },
    };
    const replies = await Promise.all([
      api("POST", path, { token: participant, body }),
      api("POST", path, { token: participant, body }),
    ]);
    assertEquals(replies.map((reply) => reply.status).sort(), [201, 400]);
    assertEquals(
      (replies.find((reply) => reply.status === 400)!.body as { error: string })
        .error,
      "该竞赛中已提交过此套卷，只允许提交一次",
    );
    const accepted = replies.find((reply) => reply.status === 201)!.body as {
      data: { score: number | null; details?: unknown };
    };
    assertEquals(accepted.data.score, type === "oi" ? null : 100);
    assertFalse(JSON.stringify(accepted.data).includes("expected"));
    assertFalse(JSON.stringify(accepted.data).includes("explanation"));
    assertEquals(
      (await ranking(contest, admin)).data.find((row) =>
        row.user_id === participantId
      )!.total_score,
      10000,
    );
  }
});

formatTest(
  "ACM：WA、CE、WA、AC后WA仅计两次罚时，封榜与本人结果独立",
  async () => {
    frozen = await createContest("acm", oiProblem, {
      end_time: new Date(Date.now() + 45000).toISOString(),
      freeze_duration_seconds: 60,
      config: { penalty_minutes: 20 },
    });
    for (const code of [wrong, ce, wrong]) {
      await submit(
        frozen,
        oiProblem,
        code,
      );
    }
    const accepted = await submit(frozen, oiProblem, ac);
    frozenAccepted = accepted.id;
    const expected = Date.parse(accepted.created_at) -
      Date.parse(frozen.start_time) + 40 * 60000;
    assertEquals(
      (await ranking(frozen, admin)).data.find((row) =>
        row.user_id === participantId
      )!.penalty_ms,
      expected,
    );
    await submit(frozen, oiProblem, wrong);
    const organizer = await ranking(frozen, admin);
    assertEquals(
      organizer.data.find((row) => row.user_id === participantId)!.solved,
      1,
    );
    assertEquals(
      organizer.data.find((row) => row.user_id === participantId)!.penalty_ms,
      expected,
    );
    const board = await ranking(frozen);
    assertEquals(board.view, "frozen");
    assertEquals(board.data.length, 2);
    assertEquals(
      board.data.find((row) => row.user_id === participantId)!.solved,
      0,
    );
    assertEquals(
      board.data.find((row) => row.user_id === participantId)!.pending,
      true,
    );
    const own = await result(frozenAccepted);
    assertEquals(own.result_visibility, "summary");
    assertEquals((own.result as { score: number }).score, 10000);
    noData(own.result);
  },
);

formatTest(
  "ACM赛后按实际窗口结算并发布正式快照，不通过回写时间结束",
  async () => {
    while (Date.now() <= Date.parse(frozen.end_time)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const settled = await call(
      "GET",
      `${root}/contests/${frozen.id}/settlement`,
      admin,
    ) as {
      data: { pending_count: number; failed_count: number; ready: boolean };
    };
    assertEquals(settled.data.pending_count, 0);
    assertEquals(settled.data.failed_count, 0);
    assertEquals(settled.data.ready, true);
    await call("POST", `${root}/contests/${frozen.id}/publish-ranking`, admin, {
      note: "真实OI Native比赛正式结果",
    });
    const official = await ranking(frozen);
    assertEquals(official.view, "official");
    assertEquals(
      official.data.find((row) => row.user_id === participantId)!.solved,
      1,
    );
    const final = await call(
      "GET",
      `${root}/contests/${frozen.id}/final-ranking`,
      participant,
    ) as { data: Row[]; snapshot: { version: number } };
    assertEquals(final.snapshot.version, 1);
    assertEquals(
      final.data.find((row) => row.user_id === participantId)!.solved,
      1,
    );
  },
);
