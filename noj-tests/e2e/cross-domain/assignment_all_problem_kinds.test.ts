/** 40人×5题的真实教学旅程：普通教师、两份作业与五题型实际执行。 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { strToU8, zipSync } from "npm:fflate@0.8.2";
import {
  api,
  BASE_URL,
  getAdminToken,
  isE2E,
  registerUser,
  TEST_PASSWORD,
  waitForServer,
} from "../helper.ts";

type Kind = "oi" | "ai" | "llm" | "artifact" | "objective";
interface Account {
  id: string;
  email: string;
  token: string;
}
interface Problem {
  kind: Kind;
  id: string;
  number: number;
  version: string;
  binding: string;
}
interface Task {
  id: string;
  revision: number;
  published_at: string;
  ended_at: string | null;
  items: {
    id: string;
    problem_id: string;
    published_version_id: string;
    answer_version_id: string;
  }[];
}
interface Cell {
  item_id: string;
  user_id: string;
  status: string;
  score: number | null;
  accepted: boolean;
  source_submission_id: string | null;
  source_attempt_id: string | null;
  evaluated_version_id: string | null;
  late: boolean;
}
interface Progress {
  updating: boolean;
  cells: Cell[];
  items: { id: string; answer_version_id: string }[];
}
interface Matrix {
  updating: boolean;
  total: number;
  items: { id: string }[];
  rows: { user_id: string; cells: Cell[] }[];
}
interface Submission {
  id: string;
  domain_id: string;
  user_id: string;
  status: string;
  created_at: string;
  submitted_version_id: string;
  assignment_origin:
    | { assignment_id: string; assignment_item_id: string }
    | null;
  accepted_attempt_id: string | null;
  result: { score: number };
}

const suffix = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;
const slug = `all-kinds-${suffix}`, root = `/api/v1/domains/${slug}`;
const kinds: Kind[] = ["oi", "ai", "llm", "artifact", "objective"];
const mockUrl = Deno.env.get("E2E_LLM_MOCK_URL") ??
  "http://noj-e2e-llm-mock:8002/v1";
const model = `teaching-${suffix}`;

async function request<T>(
  method: string,
  path: string,
  token: string,
  expected: number,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await api(method, path, { token, body, headers });
  assertEquals(
    response.status,
    expected,
    `${method} ${path}: ${JSON.stringify(response.body)}`,
  );
  return response.body as T;
}
async function account(label: string): Promise<Account> {
  const username = `${label}_${suffix}`, email = `${username}@test.com`;
  const token = await registerUser(username, email, TEST_PASSWORD);
  const me = await request<{ data: { id: string; is_admin: boolean } }>(
    "GET",
    "/api/v1/auth/me",
    token,
    200,
  );
  assertEquals(me.data.is_admin, false);
  return { id: me.data.id, email, token };
}
async function invite(path: string, inviter: string, recipient: Account) {
  const invitation = await request<{ data: { token: string } }>(
    "POST",
    `${path}/invitations`,
    inviter,
    201,
    { email: recipient.email },
  );
  await request(
    "POST",
    "/api/v1/domain-invitations/accept",
    recipient.token,
    200,
    { token: invitation.data.token },
  );
}
const aiCode = (value: number) =>
  `from noj_solution_sdk import register\n@register\ndef solve(): return ${value}\n`;

/** 一份小工厂复用现有v2/SDK协议；每题仅声明自己的执行差异。 */
async function importProblem(kind: Kind, actor: string): Promise<Problem> {
  const dual = {
    evaluator: {
      image: "noj-evaluator-python",
      time_limit_ms: kind === "llm" ? 30000 : 10000,
      memory_limit_mb: 512,
      ...(kind === "llm" ? { network: { enabled: true } } : {}),
    },
    solution: {
      image: "noj-solution-python",
      call_timeout_ms: 5000,
      memory_limit_mb: 256,
    },
  };
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
          score: 60,
          cases: [{ id: "one", input: "one.in", output: "one.out" }],
        },
        {
          id: "large",
          score: 40,
          cases: [{ id: "two", input: "two.in", output: "two.out" }],
        },
      ],
    }
    : dual;
  const manifest = {
    format_version: 2,
    title: `教学${kind} ${suffix}`,
    difficulty: "easy",
    ...(kind === "objective"
      ? { is_objective: true }
      : { judge_type: kind === "oi" ? "oi" : "dual", runtime_config: runtime }),
    ...(kind === "artifact" ? { submission_mode: "artifact" } : {}),
    ...(kind === "llm" ? { llm: { max_calls: 5 } } : {}),
  };
  const files: Record<string, Uint8Array> = {
    "problem.json": strToU8(JSON.stringify(manifest)),
    "statement.md": strToU8(`# ${kind}\n真实教学验收题目。`),
  };
  if (kind === "oi") {
    files["one.in"] = strToU8("1\n");
    files["one.out"] = strToU8("1\n");
    files["two.in"] = strToU8("2\n");
    files["two.out"] = strToU8("2\n");
  } else if (kind === "objective") {
    files["questions.json"] = strToU8(
      JSON.stringify([{
        key: "sum",
        type: "single",
        prompt: "1+1？",
        options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
        answer: ["A"],
        explanation: "两个一之和。",
      }]),
    );
  } else if (kind === "llm") {
    files["evaluate.py"] = strToU8(`from noj_evaluator_sdk import llm, result
response = llm.complete(messages=[{"role":"user","content":"ping"}])
if response.get("ok") and response.get("usage", {}).get("total_tokens") == 8:
    result.accept(score=100)
else:
    result.wrong_answer(score=0, message="Mock response mismatch")
`);
  } else {
    files["evaluate.py"] = strToU8(
      `from noj_evaluator_sdk import SolutionRunner, result
runner = SolutionRunner()
try:
    value = runner.call("solve")
    if value == ${kind === "artifact" ? 42 : 100}:
        result.accept(score=100)
    else:
        result.wrong_answer(score=${kind === "artifact" ? 0 : 60})
finally:
    runner.close()
`,
    );
  }
  const bytes = zipSync(files), form = new FormData();
  form.set(
    "file",
    new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" }),
    `${kind}.zip`,
  );
  const response = await fetch(`${BASE_URL}${root}/problems/import-bundle`, {
    method: "POST",
    headers: { Authorization: `Bearer ${actor}` },
    body: form,
  });
  const body = await response.json();
  assertEquals(response.status, 201, JSON.stringify(body));
  const draft = body.data as {
    problem_id: string;
    number: number;
    draft_revision: number;
  };
  const published = await request<{ version_id: string }>(
    "POST",
    `${root}/problems/${draft.number}/publish`,
    actor,
    200,
    { change_note: "五题型教学V1" },
    { "If-Match": String(draft.draft_revision) },
  );
  return {
    kind,
    id: draft.problem_id,
    number: draft.number,
    version: published.version_id,
    binding: "",
  };
}
async function publishAssignment(
  classroom: string,
  teacher: Account,
  problems: Problem[],
  label: string,
): Promise<Task> {
  const draft = await request<{ data: { id: string; revision: number } }>(
    "POST",
    `${root}/classrooms/${classroom}/assignments`,
    teacher.token,
    201,
    {
      title: `五题型作业${label}`,
      deadline_at: new Date(Date.now() + 900000).toISOString(),
      items: problems.map((problem) => ({
        binding_id: problem.binding,
        requirement: problem.kind === "oi" ? "min_score" : "accepted",
        ...(problem.kind === "oi" ? { minimum_score: 6000 } : {}),
      })),
    },
  );
  await request(
    "POST",
    `${root}/assignments/${draft.data.id}/publish`,
    teacher.token,
    200,
    {},
    {
      "If-Match": String(draft.data.revision),
      "Idempotency-Key": crypto.randomUUID(),
    },
  );
  return (await request<{ data: Task }>(
    "GET",
    `${root}/assignments/${draft.data.id}`,
    teacher.token,
    200,
  )).data;
}
async function matrix(task: Task, teacher: Account): Promise<Matrix> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await request<{ data: Matrix }>(
      "GET",
      `${root}/assignments/${task.id}/matrix`,
      teacher.token,
      200,
    );
    if (!result.data.updating) return result.data;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("40×5矩阵投影未在15秒内更新");
}
async function progress(
  task: Task,
  student: Account,
  scope = "on_time",
): Promise<Progress> {
  const result = await request<{ data: Progress }>(
    "GET",
    `${root}/assignments/${task.id}/progress?scope=${scope}`,
    student.token,
    200,
  );
  assertEquals(result.data.updating, false);
  assertEquals(result.data.cells.length, 5);
  assert(result.data.cells.every((cell) => cell.user_id === student.id));
  return result.data;
}
async function finish(id: string, student: Account): Promise<Submission> {
  for (let attempt = 0; attempt < 90; attempt++) {
    const response = await request<{ data: Submission }>(
      "GET",
      `${root}/submissions/${id}`,
      student.token,
      200,
    );
    if (response.data.status === "error") {
      throw new Error(`Judge平台失败: ${JSON.stringify(response.data)}`);
    }
    if (response.data.status === "finished") return response.data;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`等待实际Judge超时: ${id}`);
}

Deno.test({
  name: "[e2e/assignment-all-kinds] 40名学生×5题、两任务自动计入与真实截止补做",
  ignore: !isE2E,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    await waitForServer();
    assert(
      (Deno.env.get("E2E_JUDGE_RESOURCE_POOLS") ?? "ai").split(",").includes(
        "oi-native",
      ),
      "完整教学验收必须启用实际OI Native Worker",
    );
    const admin = await getAdminToken(),
      owner = await account("kinds_owner"),
      teacher = await account("kinds_teacher");
    const students: Account[] = [], problems: Problem[] = [];
    const completed = new Map<Kind, { id: string; received: string }>();
    let domainId = "", classroom = "", provider = "";
    let taskA: Task, taskB: Task;
    const itemFor = (task: Task, problem: Problem) =>
      task.items.find((item) => item.problem_id === problem.id)!;

    assert(
      await t.step("普通教师建班，40学生接受班级邀请并成为域成员", async () => {
        const domain = await request<{ data: { id: string } }>(
          "POST",
          "/api/v1/domains",
          admin,
          201,
          { slug, name: "40人全题型教学", preset: "education" },
        );
        domainId = domain.data.id;
        await invite(root, admin, owner);
        await request("POST", `${root}/transfer`, admin, 200, {
          user_id: owner.id,
        });
        await invite(root, owner.token, teacher);
        await request(
          "PUT",
          `${root}/members/${teacher.id}/roles`,
          owner.token,
          200,
          { roles: ["educator", "editor"] },
        );
        await request(
          "GET",
          "/api/v1/admin/instance/domains",
          teacher.token,
          403,
        );
        classroom = (await request<{ data: { id: string } }>(
          "POST",
          `${root}/classrooms`,
          teacher.token,
          201,
          { name: "40人教学班" },
        )).data.id;
        // 有限8人批次；不为矩阵创建200个评测任务。
        for (let start = 0; start < 40; start += 8) {
          const batch = await Promise.all(
            Array.from({ length: 8 }, async (_, index) => {
              const student = await account(`kinds_s${start + index}`);
              await invite(
                `${root}/classrooms/${classroom}`,
                owner.token,
                student,
              );
              return student;
            }),
          );
          students.push(...batch);
        }
        assertEquals(students.length, 40);
        assertEquals(new Set(students.map((student) => student.id)).size, 40);
      }),
    );

    assert(
      await t.step(
        "域内Provider/model、五题型V1及两份40人作业实际发布",
        async () => {
          const created = await request<
            { data: { id: string; domain_id: string } }
          >("POST", `${root}/llm/providers`, owner.token, 201, {
            name: "教学独立Mock",
            base_url: mockUrl,
            api_key: "isolated-e2e-mock-key",
            enabled: true,
          }, { "If-Match": "0" });
          provider = created.data.id;
          const settings = await request<{ data: { revision: number } }>(
            "GET",
            `${root}/llm/settings`,
            owner.token,
            200,
          );
          await request("PUT", `${root}/llm/settings`, owner.token, 200, {
            provider_id: provider,
            model,
          }, { "If-Match": String(settings.data.revision) });
          for (const kind of kinds) {
            problems.push(
              await importProblem(kind, kind === "llm" ? admin : teacher.token),
            );
          }
          const bindings = await request<
            {
              items: {
                binding_id: string;
                reference: { problem_id: string };
              }[];
            }
          >("GET", `${root}/problem-bindings?limit=10`, owner.token, 200);
          for (const problem of problems) {
            problem.binding = bindings.items.find((item) =>
              item.reference.problem_id === problem.id
            )!.binding_id;
          }
          taskA = await publishAssignment(classroom, teacher, problems, "A");
          taskB = await publishAssignment(classroom, teacher, problems, "B");
          assertNotEquals(taskA.id, taskB.id);
          for (const task of [taskA, taskB]) {
            assertEquals(task.items.length, 5);
            for (const problem of problems) {
              assertEquals(
                itemFor(task, problem).published_version_id,
                problem.version,
              );
            }
            const grid = await matrix(task, teacher);
            assertEquals(grid.total, 40);
            assertEquals(grid.rows.length, 40);
            assertEquals(grid.items.length, 5);
            assertEquals(grid.rows.flatMap((row) => row.cells).length, 200);
            assert(
              grid.rows.every((row) =>
                row.cells.every((cell) =>
                  cell.status === "not_started" && cell.score === null
                )
              ),
            );
          }
        },
      ),
    );

    assert(
      await t.step(
        "一名学生实际执行OI、AI、LLM、产物与客观题，不写数据库成绩",
        async () => {
          const student = students[0];
          for (const problem of problems) {
            const origin = {
              assignment_id: taskA.id,
              assignment_item_id: itemFor(taskA, problem).id,
            };
            if (problem.kind === "objective") {
              const result = await request<
                {
                  data: {
                    submission_id: string;
                    domain_id: string;
                    score: number;
                  };
                }
              >(
                "POST",
                `${root}/problems/${problem.number}/objective-submissions`,
                student.token,
                201,
                {
                  ...origin,
                  version_id: problem.version,
                  answers: { sum: ["A"] },
                },
              );
              assertEquals(result.data.score, 100);
              assertEquals(result.data.domain_id, domainId);
              const historical = await request<
                {
                  data: {
                    created_at: string;
                    submitted_version_id: string;
                    assignment_origin: unknown;
                    is_accepted: boolean;
                  };
                }
              >(
                "GET",
                `${root}/objective-submissions/${result.data.submission_id}`,
                student.token,
                200,
              );
              assertEquals(
                historical.data.submitted_version_id,
                problem.version,
              );
              assertEquals(historical.data.assignment_origin, origin);
              assertEquals(historical.data.is_accepted, true);
              completed.set(problem.kind, {
                id: result.data.submission_id,
                received: historical.data.created_at,
              });
              continue;
            }
            let id: string;
            if (problem.kind === "artifact") {
              const artifact = zipSync({
                  "submission.py": strToU8(aiCode(42)),
                }),
                form = new FormData();
              form.set("problem_ref", String(problem.number));
              form.set("version_id", problem.version);
              form.set("language", "python3");
              form.set(
                "file",
                new Blob([artifact.buffer as ArrayBuffer], {
                  type: "application/zip",
                }),
                "submission.zip",
              );
              const response = await fetch(
                `${BASE_URL}${root}/submissions?${new URLSearchParams(origin)}`,
                {
                  method: "POST",
                  headers: { Authorization: `Bearer ${student.token}` },
                  body: form,
                },
              );
              const body = await response.json();
              assertEquals(response.status, 201, JSON.stringify(body));
              id = body.data.id;
            } else {
              const code = problem.kind === "oi"
                ? "#include <iostream>\nint main(){std::cout<<1<<'\\n';}"
                : aiCode(problem.kind === "ai" ? 100 : 1);
              id = (await request<{ data: { id: string } }>(
                "POST",
                `${root}/submissions`,
                student.token,
                201,
                {
                  ...origin,
                  problem_ref: String(problem.number),
                  version_id: problem.version,
                  language: problem.kind === "oi" ? "cc" : "python3",
                  code,
                },
              )).data.id;
            }
            const result = await finish(id, student);
            assertEquals(result.domain_id, domainId);
            assertEquals(result.user_id, student.id);
            assertEquals(result.submitted_version_id, problem.version);
            assertEquals(result.assignment_origin, origin);
            assertEquals(
              result.result.score,
              problem.kind === "oi" ? 6000 : 10000,
            );
            assertEquals(
              result.accepted_attempt_id !== null,
              problem.kind !== "oi",
            );
            completed.set(problem.kind, { id, received: result.created_at });
          }
        },
      ),
    );

    assert(
      await t.step(
        "同一提交计入两作业；40×5矩阵只有一人达标，LLM用量归本域",
        async () => {
          for (const task of [taskA, taskB]) {
            const own = await progress(task, students[0]);
            for (const problem of problems) {
              const cell = own.cells.find((cell) =>
                cell.item_id === itemFor(task, problem).id
              )!;
              assertEquals(cell.status, "achieved");
              assertEquals(cell.accepted, problem.kind !== "oi");
              assertEquals(cell.score, problem.kind === "oi" ? 6000 : 10000);
              assertEquals(
                cell.source_submission_id,
                completed.get(problem.kind)!.id,
              );
              assert(
                Date.parse(completed.get(problem.kind)!.received) >=
                  Date.parse(task.published_at),
                "按时候选使用真实受理时间且在两份作业发布后受理",
              );
              assertEquals(cell.evaluated_version_id, problem.version);
              assert(cell.source_attempt_id);
              assertEquals(cell.late, false);
            }
            const grid = await matrix(task, teacher);
            assertEquals(grid.total, 40);
            assertEquals(grid.rows.length, 40);
            assertEquals(grid.rows.flatMap((row) => row.cells).length, 200);
            assertEquals(
              grid.rows.filter((row) =>
                row.cells.every((cell) => cell.status === "achieved")
              ).map((row) => row.user_id),
              [students[0].id],
            );
            assert(
              grid.rows.filter((row) => row.user_id !== students[0].id).every((
                row,
              ) =>
                row.cells.every((cell) =>
                  cell.status === "not_started" && cell.score === null
                )
              ),
            );
          }
          const llm = problems.find((problem) => problem.kind === "llm")!;
          const usage = await request<
            {
              data: {
                domain_id: string;
                provider_id: string;
                model: string;
                total_tokens: number;
                status: string;
                submission_id: string;
                problem_id: string;
                problem_version_id: string;
                attempt_id: string;
              }[];
            }
          >(
            "GET",
            `${root}/llm/usage?submission_id=${completed.get("llm")!.id}`,
            owner.token,
            200,
          );
          assertEquals(usage.data.length, 1);
          const entry = usage.data[0];
          assertEquals(entry.domain_id, domainId);
          assertEquals(entry.provider_id, provider);
          assertEquals(entry.model, model);
          assertEquals(entry.total_tokens, 8);
          assertEquals(entry.status, "ok");
          assertEquals(entry.problem_id, llm.id);
          assertEquals(entry.problem_version_id, llm.version);
          assertEquals(entry.submission_id, completed.get("llm")!.id);
          assertEquals(
            (await progress(taskA, students[0])).cells.find((cell) =>
              cell.item_id === itemFor(taskA, llm).id
            )!.source_attempt_id,
            entry.attempt_id,
          );
        },
      ),
    );

    assert(
      await t.step(
        "学生仅本人进度，可读授权提交摘要但不能读取矩阵、同学源码或域Provider",
        async () => {
          const matrix = await request<{ data: { rows: unknown[] } }>(
            "GET",
            `${root}/assignments/${taskA.id}/matrix`,
            students[0].token,
            200,
          );
          assert(matrix.data.rows.length > 0);
          await request(
            "GET",
            `${root}/assignments/${taskA.id}/matrix.csv`,
            students[1].token,
            403,
          );
          const peerSummary = await request<{ data: Record<string, unknown> }>(
            "GET",
            `${root}/submissions/${completed.get("ai")!.id}`,
            students[1].token,
            200,
          );
          assertEquals(peerSummary.data.user_id, students[0].id);
          assertEquals(peerSummary.data.can_view_source, false);
          assertEquals(peerSummary.data.can_view_answers, false);
          assertEquals(peerSummary.data.code, undefined);
          assertEquals(peerSummary.data.answers, undefined);
          assertEquals(peerSummary.data.assignment_origin, null);
          await request("GET", `${root}/llm/providers`, students[0].token, 403);
          const peer = await request<{ data: Progress }>(
            "GET",
            `${root}/assignments/${taskA.id}/progress?user_id=${
              students[0].id
            }`,
            students[1].token,
            200,
          );
          assertEquals(peer.data.cells.length, 5);
          assert(
            peer.data.cells.every((cell) =>
              cell.user_id === students[1].id &&
              cell.status === "not_started" &&
              cell.source_submission_id === null
            ),
          );
          await request(
            "GET",
            `${root}/classrooms/${classroom}/submissions/submission/${
              completed.get("ai")!.id
            }`,
            teacher.token,
            200,
          );
        },
      ),
    );

    assert(
      await t.step(
        "实际结束A后再提交OI满分，按时成绩保留60且补做提升100，B继续自动计入",
        async () => {
          const ended = await request<{ data: Task }>(
            "POST",
            `${root}/assignments/${taskA.id}/end`,
            teacher.token,
            200,
            { reason: "检查真实按时与补做窗口" },
            { "If-Match": String(taskA.revision) },
          );
          assert(ended.data.ended_at);
          for (const submission of completed.values()) {
            assert(
              Date.parse(submission.received) <=
                Date.parse(ended.data.ended_at),
              "原五题提交在实际结束前受理",
            );
          }
          const oi = problems.find((problem) => problem.kind === "oi")!;
          const after = await request<{ data: { id: string } }>(
            "POST",
            `${root}/submissions`,
            students[0].token,
            201,
            {
              problem_ref: String(oi.number),
              version_id: oi.version,
              language: "cc",
              code:
                "#include <iostream>\nint main(){int x;std::cin>>x;std::cout<<x<<'\\n';}",
            },
          );
          const late = await finish(after.data.id, students[0]);
          assert(Date.parse(late.created_at) > Date.parse(ended.data.ended_at));
          assertEquals(late.result.score, 10000);
          assert(late.accepted_attempt_id);
          const onTime = (await progress(taskA, students[0])).cells.find((
            cell,
          ) => cell.item_id === itemFor(taskA, oi).id)!;
          assertEquals(onTime.score, 6000);
          assertEquals(onTime.accepted, false);
          assertEquals(onTime.source_submission_id, completed.get("oi")!.id);
          assertEquals(onTime.late, false);
          const current = (await progress(taskA, students[0], "current")).cells
            .find((cell) => cell.item_id === itemFor(taskA, oi).id)!;
          assertEquals(current.score, 10000);
          assertEquals(current.accepted, true);
          assertEquals(current.source_submission_id, late.id);
          assertEquals(current.late, true);
          assertEquals(current.evaluated_version_id, oi.version);
          const ongoing = (await progress(taskB, students[0])).cells.find((
            cell,
          ) => cell.item_id === itemFor(taskB, oi).id)!;
          assertEquals(ongoing.score, 10000);
          assertEquals(ongoing.source_submission_id, late.id);
          assertEquals(ongoing.late, false);
          for (const task of [taskA, taskB]) {
            const history = await request<
              {
                data: {
                  data: { answer_version_id: string; item_id: string }[];
                };
              }
            >(
              "GET",
              `${root}/assignments/${task.id}/history`,
              teacher.token,
              200,
            );
            for (const problem of problems) {
              assert(
                history.data.data.some((entry) =>
                  entry.item_id === itemFor(task, problem).id &&
                  entry.answer_version_id === problem.version
                ),
              );
            }
          }
        },
      ),
    );
  },
});
