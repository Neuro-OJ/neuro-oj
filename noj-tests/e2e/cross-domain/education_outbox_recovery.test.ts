/** 真实 Judge、持久投影及 core 进程重启验收，不通过进度读取接口触发修复。 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import postgres from "npm:postgres@3.4.5";
import { createCodingProblemFixture } from "../../fixtures/coding-problem.ts";
import {
  api,
  getAdminToken,
  isE2E,
  registerUser,
  TEST_PASSWORD,
  waitForServer,
} from "../helper.ts";

interface Cell {
  id: string;
  scope: "on_time" | "current";
  score: number | null;
  accepted: boolean;
  source_submission_id: string | null;
  source_attempt_id: string | null;
  evaluated_version_id: string | null;
  policy_revision: number;
  projection_revision: string;
  late: boolean;
}
interface Event {
  id: string;
  domain_id: string;
  event_type: string;
  user_id: string | null;
  problem_id: string | null;
  classroom_id: string | null;
  assignment_id: string | null;
  payload: Record<string, postgres.JSONValue>;
  created_at: string;
}
interface ContainerState {
  Pid: number;
  StartedAt: string;
  Running: boolean;
}

async function request<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await api(method, `/api/v1${path}`, {
    token,
    body,
    headers,
  });
  assert(
    response.status >= 200 && response.status < 300,
    `${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`,
  );
  return response.body as T;
}
async function docker(...args: string[]) {
  const response = await new Deno.Command("docker", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(response.code, 0, new TextDecoder().decode(response.stderr));
  return new TextDecoder().decode(response.stdout).trim();
}
async function state(container: string): Promise<ContainerState> {
  return JSON.parse(
    await docker("inspect", "--format", "{{json .State}}", container),
  );
}
async function waitUntil<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  label: string,
  timeout = 30000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待${label}超时`);
}

Deno.test({
  name:
    "[e2e/education-outbox-recovery] 重复乱序按最新事实重算，真实core重启恢复积压",
  ignore: !isE2E,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const sql = postgres(
      Deno.env.get("E2E_DB_URL") ?? Deno.env.get("DATABASE_URL")!,
      { max: 1 },
    );
    const core = Deno.env.get("E2E_CORE_CONTAINER") ?? "noj-e2e-core",
      judge = Deno.env.get("E2E_JUDGE_CONTAINER") ?? "noj-e2e-judge",
      gateway = Deno.env.get("E2E_GATEWAY_CONTAINER") ?? "noj-e2e-llm-gateway";
    const suffix = `${Date.now().toString(36)}${
      crypto.randomUUID().slice(0, 4)
    }`;
    const slug = `recover-${suffix}`, root = `/domains/${slug}`;
    let coreStopped = false;
    try {
      await waitForServer();
      const admin = await getAdminToken();
      const teacherEmail = `recover_teacher_${suffix}@test.com`,
        studentEmail = `recover_student_${suffix}@test.com`;
      const teacher = await registerUser(
        `recover_teacher_${suffix}`,
        teacherEmail,
        TEST_PASSWORD,
      );
      const student = await registerUser(
        `recover_student_${suffix}`,
        studentEmail,
        TEST_PASSWORD,
      );
      const teacherId =
        (await request<{ data: { id: string } }>("GET", "/auth/me", teacher))
          .data.id;
      const studentId =
        (await request<{ data: { id: string } }>("GET", "/auth/me", student))
          .data.id;
      const domain = await request<{ data: { id: string } }>(
        "POST",
        "/domains",
        admin,
        { slug, name: `恢复验收 ${suffix}`, preset: "education" },
      );
      const teacherInvite = await request<{ data: { token: string } }>(
        "POST",
        `${root}/invitations`,
        admin,
        { email: teacherEmail },
      );
      await request("POST", "/domain-invitations/accept", teacher, {
        token: teacherInvite.data.token,
      });
      await request("POST", `${root}/transfer`, admin, { user_id: teacherId });
      const classroom = await request<{ data: { id: string } }>(
        "POST",
        `${root}/classrooms`,
        teacher,
        { name: "持久事件班" },
      );
      const studentInvite = await request<{ data: { token: string } }>(
        "POST",
        `${root}/classrooms/${classroom.data.id}/invitations`,
        teacher,
        { email: studentEmail },
      );
      await request("POST", "/domain-invitations/accept", student, {
        token: studentInvite.data.token,
      });
      const problemId = await createCodingProblemFixture();
      const source = await request<{ data: { number: number } }>(
        "GET",
        `/problems/${problemId}`,
        admin,
      );
      const reference = `main:${source.data.number}`;
      const sharePath = `/domains/main/problems/${source.data.number}/sharing`;
      const sharing = await request<{ data: { revision: number } }>(
        "GET",
        sharePath,
        admin,
      );
      await request("POST", sharePath, admin, {
        enabled: true,
        scope: "selected",
        target_domain_slugs: [slug],
      }, { "If-Match": String(sharing.data.revision) });
      const binding = await request<
        { data: { binding: { id: string; revision: number } } }
      >("POST", `${root}/problem-bindings`, teacher, { source_ref: reference });
      const problem = await request<{ version_id: string }>(
        "GET",
        `${root}/problems/${reference}`,
        student,
      );
      const draft = await request<{ data: { id: string; revision: number } }>(
        "POST",
        `${root}/classrooms/${classroom.data.id}/assignments`,
        teacher,
        {
          title: "真实受理时间与恢复",
          deadline_at: new Date(Date.now() + 3600000).toISOString(),
          items: [{
            binding_id: binding.data.binding.id,
            requirement: "accepted",
          }],
        },
      );
      const taskId = draft.data.id;
      await request(
        "POST",
        `${root}/assignments/${taskId}/publish`,
        teacher,
        {},
        {
          "If-Match": String(draft.data.revision),
          "Idempotency-Key": crypto.randomUUID(),
        },
      );
      const cells = () =>
        sql<
          Cell[]
        >`SELECT id,scope,score,accepted,source_submission_id,source_attempt_id,evaluated_version_id,policy_revision,projection_revision,late
        FROM assignment_progress WHERE assignment_id=${taskId} AND user_id=${studentId} ORDER BY scope`;
      const events = () =>
        sql<
          Event[]
        >`SELECT id,domain_id,event_type,user_id,problem_id,classroom_id,assignment_id,payload,created_at
        FROM education_outbox WHERE domain_id=${domain.data.id} AND user_id=${studentId} AND problem_id=${problemId}
        AND event_type='submission.changed' ORDER BY created_at DESC,id DESC LIMIT 1`;
      const submit = async (code: string) =>
        (await request<{ data: { id: string } }>(
          "POST",
          `${root}/submissions`,
          student,
          {
            problem_ref: reference,
            version_id: problem.version_id,
            language: "python3",
            code,
          },
        )).data.id;
      const attempt = async (submissionId: string, score: number) => {
        const rows = await waitUntil(
          () =>
            sql<
              {
                id: string;
                problem_version_id: string;
                score: number;
                result_kind: string;
                finished_at: string;
              }[]
            >`
            SELECT id,problem_version_id,score,result_kind,finished_at FROM evaluation_attempts
            WHERE submission_id=${submissionId} AND result_kind='graded' ORDER BY sequence DESC LIMIT 1`,
          (rows) => rows.length === 1,
          "实际Judge正式判定",
        );
        assertEquals(rows[0].score, score);
        assertEquals(rows[0].problem_version_id, problem.version_id);
        return rows[0];
      };
      const replay = async (event: Event, deliveries: number) => {
        const ids = [];
        for (let n = 0; n < deliveries; n++) {
          const id = crypto.randomUUID(), payload = { ...event.payload };
          delete payload._education_cursor;
          // 复用生产中到期事件的失效机制，只修改交付元数据，不写业务事实。
          payload._invalidate_on_claim = true;
          await sql`INSERT INTO education_outbox(id,domain_id,event_type,user_id,problem_id,classroom_id,assignment_id,payload,created_at,available_at)
            VALUES(${id},${event.domain_id},${event.event_type},${event.user_id},${event.problem_id},${event.classroom_id},${event.assignment_id},${
            sql.json(payload)
          },${event.created_at},${new Date().toISOString()})`;
          // P4 已切换为 background_tasks 是唯一生产消费者；手工重放也必须登记
          // 同一稳定 outbox 身份的通用任务，否则真实 core 不会扫描裸 outbox 行。
          const taskPayload = {
            outbox_id: id,
            domain_id: event.domain_id,
            event_type: event.event_type,
            user_id: event.user_id,
            problem_id: event.problem_id,
            classroom_id: event.classroom_id,
            assignment_id: event.assignment_id,
            education_cursor: null,
          };
          const now = new Date().toISOString();
          await sql`INSERT INTO background_tasks(
            id,task_type,target_kind,target_id,dedupe_key,payload_version,payload,status,available_at,created_at,updated_at
          ) VALUES(
            ${crypto.randomUUID()},'education.recompute',
            ${event.assignment_id ? "assignment" : "domain"},
            ${event.assignment_id ?? event.domain_id},${`outbox:${id}`},1,
            ${sql.json(taskPayload)},'pending',${now},${now},${now}
          )`;
          ids.push(id);
        }
        return ids;
      };
      const processed = async (ids: string[]) =>
        await waitUntil(
          () =>
            sql<
              {
                id: string;
                processed_at: string | null;
                last_error: string | null;
              }[]
            >`
          SELECT id,processed_at,last_error FROM education_outbox WHERE id IN ${
              sql(ids)
            }`,
          (rows) =>
            rows.length === ids.length && rows.every((row) =>
              row.processed_at !== null && row.last_error === null
            ),
          "真实消费者完成交付",
        );
      const step = async (name: string, action: () => Promise<void>) => {
        assertEquals(await t.step(name, action), true, name);
      };
      let firstId = "",
        secondId = "",
        firstAttempt = "",
        secondAttempt = "",
        policyRevision = 0;
      let oldEvent: Event, newEvent: Event;
      let expected: unknown;
      const identity = (rows: Cell[]) =>
        rows.map((row) => ({
          id: row.id,
          scope: row.scope,
          score: row.score,
          accepted: row.accepted,
          source_submission_id: row.source_submission_id,
          source_attempt_id: row.source_attempt_id,
          evaluated_version_id: row.evaluated_version_id,
          policy_revision: row.policy_revision,
          late: row.late,
        }));
      await step(
        "真实零分提交在后台5秒内进入两种统计，不读取REST修复投影",
        async () => {
          firstId = await submit("def solve(input_str):\n    return '0'\n");
          const graded = await attempt(firstId, 0);
          firstAttempt = graded.id;
          const updated = await waitUntil(
            cells,
            (rows) =>
              rows.length === 2 &&
              rows.every((row) =>
                row.source_submission_id === firstId &&
                row.source_attempt_id === firstAttempt
              ),
            "原提交后台投影",
            5000,
          );
          assert(
            updated.every((row) =>
              row.score === 0 && !row.accepted && !row.late
            ),
          );
          oldEvent = (await events())[0];
          assert(oldEvent);
          const elapsed = Date.now() - Date.parse(graded.finished_at);
          assert(elapsed <= 5000, `正常后台更新耗时 ${elapsed}ms`);
          console.log(
            JSON.stringify({
              normal_progress_ms: elapsed,
              first_submission: firstId,
              first_attempt: firstAttempt,
            }),
          );
        },
      );
      await step(
        "真实策略切exact(V1)、结束作业后满分补做，保存受理与尝试依据",
        async () => {
          const changed = await request<{ data: { revision: number } }>(
            "PUT",
            `${root}/problems/${reference}/policy`,
            teacher,
            {
              policy: { mode: "exact", version_id: problem.version_id },
              reason: "验证当前策略恢复",
            },
            { "If-Match": String(binding.data.binding.revision) },
          );
          policyRevision = changed.data.revision;
          const task = await request<{ data: { revision: number } }>(
            "GET",
            `${root}/assignments/${taskId}`,
            teacher,
          );
          const ended = await request<{ data: { ended_at: string } }>(
            "POST",
            `${root}/assignments/${taskId}/end`,
            teacher,
            { reason: "真实结束后继续补做" },
            { "If-Match": String(task.data.revision) },
          );
          secondId = await submit(
            "def solve(input_str):\n    return str(sum(map(int, input_str.split())))\n",
          );
          const graded = await attempt(secondId, 1000);
          secondAttempt = graded.id;
          const updated = await waitUntil(
            cells,
            (rows) =>
              rows.length === 2 && rows.some((row) =>
                row.scope === "current" &&
                row.source_submission_id === secondId &&
                row.source_attempt_id === secondAttempt
              ) &&
              rows.every((row) => row.policy_revision === policyRevision),
            "按时零分与满分补做",
          );
          const onTime = updated.find((row) => row.scope === "on_time")!,
            current = updated.find((row) => row.scope === "current")!;
          assertEquals(onTime.score, 0);
          assertEquals(onTime.source_submission_id, firstId);
          assertEquals(onTime.source_attempt_id, firstAttempt);
          assertEquals(onTime.late, false);
          assertEquals(current.score, 1000);
          assertEquals(current.accepted, true);
          assertEquals(current.late, true);
          const received = await sql<
            { id: string; created_at: string }[]
          >`SELECT id,created_at FROM submissions WHERE id IN ${
            sql([firstId, secondId])
          }`;
          assert(
            Date.parse(
              received.find((row) => row.id === firstId)!.created_at,
            ) <= Date.parse(ended.data.ended_at),
          );
          assert(
            Date.parse(
              received.find((row) => row.id === secondId)!.created_at,
            ) > Date.parse(ended.data.ended_at),
          );
          newEvent = (await events())[0];
          assert(newEvent);
          assert(
            Date.parse(oldEvent.created_at) < Date.parse(newEvent.created_at),
          );
          expected = identity(updated);
        },
      );
      await step(
        "新事件先交付，旧事件后交付两次，最新事实和两个scope单元不变",
        async () => {
          const before = await cells();
          await processed(await replay(newEvent, 1));
          const newest = await cells();
          assertEquals(identity(newest), expected);
          assert(newest.every((row) =>
            BigInt(row.projection_revision) > BigInt(
              before.find((old) => old.scope === row.scope)!
                .projection_revision,
            )
          ));
          await processed(await replay(oldEvent, 2));
          const older = await cells();
          assertEquals(identity(older), expected);
          assertEquals(older.length, 2);
          assert(older.every((row) =>
            BigInt(row.projection_revision) > BigInt(
              newest.find((old) => old.scope === row.scope)!
                .projection_revision,
            )
          ));
        },
      );
      await step(
        "停止core制造持久积压，重启新进程自行补算；Judge和Gateway保持原进程",
        async () => {
          const before = await state(core),
            judgeBefore = await state(judge),
            gatewayBefore = await state(gateway);
          const baseline = await cells();
          await docker("stop", "--time", "5", core);
          coreStopped = true;
          assertEquals((await state(core)).Running, false);
          const deliveries = await replay(oldEvent, 2);
          const pending = await sql<
            { processed_at: string | null; lease_token: string | null }[]
          >`SELECT processed_at,lease_token FROM education_outbox WHERE id IN ${
            sql(deliveries)
          }`;
          assertEquals(pending.length, 2);
          assert(
            pending.every((row) =>
              row.processed_at === null && row.lease_token === null
            ),
          );
          assertEquals(identity(await cells()), expected);
          const started = Date.now();
          await docker("start", core);
          coreStopped = false;
          await waitForServer();
          const after = await state(core);
          assert(after.Running);
          assertNotEquals(after.Pid, before.Pid);
          assertNotEquals(after.StartedAt, before.StartedAt);
          await processed(deliveries);
          const recovered = await cells();
          assertEquals(identity(recovered), expected);
          assert(
            recovered.every((row) =>
              BigInt(row.projection_revision) > BigInt(
                baseline.find((old) => old.scope === row.scope)!
                  .projection_revision,
              )
            ),
          );
          const configured = await sql<
            {
              effective_version_mode: string;
              required_version_id: string;
              revision: number;
            }[]
          >`SELECT effective_version_mode,required_version_id,revision FROM domain_problem_bindings WHERE id=${binding.data.binding.id}`;
          assertEquals(configured[0], {
            effective_version_mode: "exact",
            required_version_id: problem.version_id,
            revision: policyRevision,
          });
          for (
            const [container, original] of [[judge, judgeBefore], [
              gateway,
              gatewayBefore,
            ]] as const
          ) {
            const current = await state(container);
            assertEquals(current.Running, true);
            assertEquals(current.Pid, original.Pid);
            assertEquals(current.StartedAt, original.StartedAt);
          }
          console.log(JSON.stringify({
            restart_and_recovery_ms: Date.now() - started,
            core_pid_before: before.Pid,
            core_pid_after: after.Pid,
            before_started_at: before.StartedAt,
            after_started_at: after.StartedAt,
            recovered_events: deliveries,
          }));
          // 后台完成证据已由DB记录确认，此后REST仅核对授权展示。
          for (const scope of ["on_time", "current"] as const) {
            const result = await request<
              {
                data: {
                  cells: {
                    source_submission_id: string;
                    source_attempt_id: string;
                    score: number;
                  }[];
                };
              }
            >(
              "GET",
              `${root}/assignments/${taskId}/progress?scope=${scope}`,
              student,
            );
            assertEquals(
              result.data.cells[0].source_submission_id,
              scope === "on_time" ? firstId : secondId,
            );
            assertEquals(
              result.data.cells[0].source_attempt_id,
              scope === "on_time" ? firstAttempt : secondAttempt,
            );
            assertEquals(
              result.data.cells[0].score,
              scope === "on_time" ? 0 : 1000,
            );
          }
        },
      );
    } finally {
      if (coreStopped) {
        await docker("start", core);
        await waitForServer();
      }
      await sql.end();
    }
  },
});
