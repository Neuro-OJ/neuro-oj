import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@^1";
import {
  createSubmission,
  getSubmission,
  rejudgeProblemSubmissions,
  rejudgeSubmission,
  saveEvaluationResult,
  updateSubmissionStatus,
} from "../../src/services/submissions.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import {
  auditLogs,
  evaluationResults,
  problems,
  submissions,
  users,
} from "../../src/db/schema.ts";
import { BadRequestError, NotFoundError } from "../../src/lib/errors.ts";
import { eq } from "drizzle-orm";
import { enterTestContext } from "../../src/lib/requestContext.ts";

/**
 * 启动一个极简的 Redis RESP 协议 mock 服务器，仅响应 LPUSH / PING / QUIT，
 * 让 pushJudgeTask 的 LPUSH 调用不会触发真实 Redis 依赖。
 *
 * PGlite 测试模式下没有 Redis，但 Deno ESM 模块导出是 non-configurable，
 * 无法直接 monkey-patch pushJudgeTask。因此这里选择启动一个本地 mock Redis，
 * 把 REDIS_URL 指向它，让 pushJudgeTask 走完整 LPUSH 路径而无需外部依赖。
 */
// deno-lint-ignore require-await
async function startFakeRedis(): Promise<
  { url: string; stop: () => Promise<void> }
> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const addr = listener.addr as Deno.NetAddr;
  const url = `redis://${addr.hostname}:${addr.port}/`;

  const connections = new Set<Deno.Conn>();
  const acceptTask = (async () => {
    for await (const conn of listener) {
      connections.add(conn);
      handleConnection(conn).catch(() => {/* ignore */});
    }
  })();

  const stop = async () => {
    for (const c of connections) {
      try {
        c.close();
      } catch { /* ignore */ }
    }
    connections.clear();
    try {
      listener.close();
    } catch { /* ignore */ }
    await acceptTask.catch(() => {/* ignore */});
  };

  return { url, stop };
}

async function handleConnection(conn: Deno.Conn): Promise<void> {
  const buf = new Uint8Array(4096);
  let pending: Uint8Array = new Uint8Array(0);

  while (true) {
    let n: number | null;
    try {
      n = await conn.read(buf);
    } catch {
      return;
    }
    if (n === null) return;
    const slice = buf.subarray(0, n);
    pending = concat(pending, new Uint8Array(slice));

    // 解析并响应所有完整 RESP 命令
    while (true) {
      const parsed = tryParseRespCommand(pending);
      if (!parsed) break;
      pending = parsed.rest;

      let reply: Uint8Array;
      switch (parsed.cmd) {
        case "PING":
          reply = renderRespString("PONG");
          break;
        case "LPUSH":
        case "CLIENT":
        case "SELECT":
        case "AUTH":
        case "HELLO":
        case "SETINFO":
          reply = renderRespString("OK");
          break;
        default:
          reply = renderRespString("OK");
      }
      await conn.write(reply);
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

interface ParsedCommand {
  cmd: string;
  rest: Uint8Array;
}

function tryParseRespCommand(buf: Uint8Array): ParsedCommand | null {
  // RESP 数组：*<n>\r\n$<len>\r\n<bytes>\r\n...
  if (buf.length === 0 || buf[0] !== 0x2a /* * */) return null;
  const headerEnd = findCrlf(buf, 0);
  if (headerEnd < 0) return null;
  const n = parseInt(new TextDecoder().decode(buf.subarray(1, headerEnd)), 10);
  if (!Number.isFinite(n)) return null;

  let pos = headerEnd + 2;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    if (pos >= buf.length || buf[pos] !== 0x24 /* $ */) return null;
    const lenEnd = findCrlf(buf, pos);
    if (lenEnd < 0) return null;
    const len = parseInt(
      new TextDecoder().decode(buf.subarray(pos + 1, lenEnd)),
      10,
    );
    if (!Number.isFinite(len)) return null;
    pos = lenEnd + 2;
    if (pos + len + 2 > buf.length) return null;
    parts.push(new TextDecoder().decode(buf.subarray(pos, pos + len)));
    pos += len + 2;
  }

  return { cmd: (parts[0] ?? "").toUpperCase(), rest: buf.slice(pos) };
}

function findCrlf(buf: Uint8Array, from: number): number {
  for (let i = from; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
}

function renderRespString(s: string): Uint8Array {
  return new TextEncoder().encode(`+${s}\r\n`);
}

const hasDb = true; // PGlite 内存数据库始终可用
const skip = !hasDb;

const ts = Date.now();
const TEST_PROBLEM_ID = `tst-pr-${ts}`;
const TEST_USER_ID = `tst-user-${ts}`;
const TEST_NUMBER = 50000 + (ts & 0x7fff);

Deno.test({
  name: "submissions service: 初始化测试题目和用户",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: TEST_USER_ID,
      username: `tstuser-${ts}`,
      email: `tst-${ts}@test.noj`,
      password_hash: "hash",
      role: "user",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problems).values({
      id: TEST_PROBLEM_ID,
      title: `测试题目 ${ts}`,
      description: "测试描述",
      difficulty: "easy",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },

        solution: {
          image: "noj-solution-python",
          entry: "submission_sample.py",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
      number: TEST_NUMBER,
      owner_id: TEST_USER_ID,
      type: "P",
      created_at: now,
      updated_at: now,
    });
  },
});

Deno.test({
  name: "submissions service: 不支持的语言抛出 BadRequestError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        createSubmission(TEST_USER_ID, {
          problem_id: TEST_PROBLEM_ID,
          language: "brainfuck",
          code: "test code",
        }),
      BadRequestError,
      "不支持的语言",
    );
  },
});

Deno.test({
  name: "submissions service: 不存在的题目抛出 NotFoundError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        createSubmission(TEST_USER_ID, {
          problem_id: "nonexistent-id",
          language: "python3",
          code: "print('hello')",
        }),
      NotFoundError,
      "题目不存在",
    );
  },
});

Deno.test({
  name: "submissions service: getSubmission 不存在的提交抛出 NotFoundError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () => getSubmission("nonexistent-id", TEST_USER_ID),
      NotFoundError,
      "提交不存在",
    );
  },
});

Deno.test({
  name: "submissions service: saveEvaluationResult 保存评测结果",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const submissionId = `tst-sr-${ts}`;

    // 先插入一条 pending 状态的提交
    await db.insert(submissions).values({
      id: submissionId,
      user_id: TEST_USER_ID,
      problem_id: TEST_PROBLEM_ID,
      language: "python3",
      code: "print('test')",
      file_name: "main.py",
      status: "judging",
      created_at: now,
    });

    // 保存评测结果
    await saveEvaluationResult({
      submission_id: submissionId,
      status: "Accepted",
      score: 1000,
      output: "---RESULT---\n{}",
      details: { score_content: 10.0 },
      time_ms: 2340,
      memory_kb: 18432,
    });

    // 验证提交状态更新为 finished
    const sub = await db
      .select({ status: submissions.status })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
      .limit(1);
    assertEquals(sub[0].status, "finished");

    // 验证评测结果已插入
    const result = await db
      .select()
      .from(evaluationResults)
      .where(eq(evaluationResults.submission_id, submissionId))
      .limit(1);
    assertEquals(result.length, 1);
    assertEquals(result[0].status, "Accepted");
    assertEquals(result[0].score, 1000);
    assertEquals(result[0].time_ms, 2340);
    assertEquals(result[0].memory_kb, 18432);
  },
});

Deno.test({
  name: "submissions service: saveEvaluationResult 重复消费幂等",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const submissionId = `tst-idemp-${ts}`;

    // 插入提交
    await db.insert(submissions).values({
      id: submissionId,
      user_id: TEST_USER_ID,
      problem_id: TEST_PROBLEM_ID,
      language: "python3",
      code: "test",
      file_name: null,
      status: "judging",
      created_at: now,
    });

    // 第一次保存
    await saveEvaluationResult({
      submission_id: submissionId,
      status: "Accepted",
      score: 1000,
      output: "",
      details: {},
    });

    // 第二次保存（模拟重复消费）
    await saveEvaluationResult({
      submission_id: submissionId,
      status: "Accepted",
      score: 1000,
      output: "",
      details: {},
    });

    // 验证 evaluation_results 只有一条
    const rows = await db
      .select()
      .from(evaluationResults)
      .where(eq(evaluationResults.submission_id, submissionId));
    assertEquals(rows.length, 1, "重复消费不应插入多行");
  },
});

// ── 消费者解析逻辑的单元测试（不需要数据库） ──

Deno.test({
  name: "consumer: 有效 JudgeResult JSON 解析",
  fn: () => {
    const rawJson =
      `{"submission_id":"sid-1","status":"Accepted","score":1000,"output":"ok","details":{}}`;
    const parsed = JSON.parse(rawJson);
    assertEquals(parsed.submission_id, "sid-1");
    assertEquals(parsed.status, "Accepted");
    assertEquals(parsed.score, 1000);
  },
});

Deno.test({
  name: "consumer: 非法 JSON 应抛出异常",
  fn: () => {
    const rawJson = "{invalid json}";
    let parseError: Error | null = null;
    try {
      JSON.parse(rawJson);
    } catch (err) {
      parseError = err instanceof Error ? err : new Error(String(err));
    }
    assertEquals(parseError !== null, true, "非法 JSON 应抛出异常");
  },
});

Deno.test({
  name: "consumer: 缺少 submission_id 的 JSON 应被检测",
  fn: () => {
    const rawJson = `{"status":"Accepted","score":1000}`;
    const parsed = JSON.parse(rawJson);
    assertEquals(
      parsed.submission_id,
      undefined,
      "缺少 submission_id 应为 undefined",
    );
    assertEquals(parsed.status, "Accepted");
    assertEquals(parsed.score, 1000);
  },
});

Deno.test({
  name:
    "submissions service: saveEvaluationResult 重复写同一 submission 应 UPDATE 而非 silently 跳过（issue #86）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const subId = crypto.randomUUID();
    const now = new Date().toISOString();

    // 创建测试用户
    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: `upsert_test_${Date.now()}`,
      email: `upsert_test_${Date.now()}@test.com`,
      password_hash: "x",
      role: "user",
      created_at: now,
      updated_at: now,
    });

    // 准备 submission（status=judging 让 UPDATE 通行）
    await db.insert(submissions).values({
      id: subId,
      user_id: userId,
      problem_id: TEST_PROBLEM_ID,
      language: "python3",
      code: "print(1)",
      status: "judging",
      created_at: now,
    });

    try {
      // 第一次写入：WrongAnswer
      await saveEvaluationResult({
        submission_id: subId,
        status: "WrongAnswer",
        score: 500,
        output: '---RESULT---\n{"first":true}',
        details: {},
      });

      // 第二次写入：Accepted（rejudge 后）
      await saveEvaluationResult({
        submission_id: subId,
        status: "Accepted",
        score: 1000,
        output: '---RESULT---\n{"new":true}',
        details: { rejudge: true },
        time_ms: 200,
        memory_kb: 2048,
      });

      // 断言：只有 1 行（UNIQUE 保持），但内容是第二次的
      const rows = await db.select().from(evaluationResults)
        .where(eq(evaluationResults.submission_id, subId));
      assertEquals(rows.length, 1);
      assertEquals(rows[0].status, "Accepted");
      assertEquals(rows[0].score, 1000);
      assertEquals(rows[0].output, '---RESULT---\n{"new":true}');
      assertEquals(JSON.parse(rows[0].details), { rejudge: true });
      assertEquals(rows[0].time_ms, 200);
      assertEquals(rows[0].memory_kb, 2048);
    } finally {
      // 清理
      await db.delete(evaluationResults).where(
        eq(evaluationResults.submission_id, subId),
      );
      await db.delete(submissions).where(eq(submissions.id, subId));
      await db.delete(users).where(eq(users.id, userId));
    }
  },
});

Deno.test({
  name:
    "submissions service: saveEvaluationResult rejudge_seq 防护：旧结果不应覆盖新结果",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const subId = crypto.randomUUID();
    const now = new Date().toISOString();

    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: `seq_guard_${Date.now()}`,
      email: `seq_guard_${Date.now()}@test.com`,
      password_hash: "x",
      role: "user",
      created_at: now,
      updated_at: now,
    });

    await db.insert(submissions).values({
      id: subId,
      user_id: userId,
      problem_id: TEST_PROBLEM_ID,
      language: "python3",
      code: "print(1)",
      status: "judging",
      rejudge_seq: 2, // 当前序列号=2
      created_at: now,
    });

    try {
      // 写入 seq=2 的新结果（应成功）
      await saveEvaluationResult({
        submission_id: subId,
        status: "Accepted",
        score: 1000,
        output: "---NEW---",
        details: { seq: 2 },
        rejudge_seq: 2,
      });

      // 写入 seq=1 的旧结果（应被丢弃，仅 console.warn）
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
      try {
        await saveEvaluationResult({
          submission_id: subId,
          status: "WrongAnswer",
          score: 500,
          output: "---OLD---",
          details: { seq: 1 },
          rejudge_seq: 1,
        });
      } finally {
        console.warn = originalWarn;
      }

      // 断言：evaluation_results 仍只有 1 行，且是 seq=2 的内容
      const rows = await db.select().from(evaluationResults)
        .where(eq(evaluationResults.submission_id, subId));
      assertEquals(rows.length, 1);
      assertEquals(rows[0].status, "Accepted");
      assertEquals(rows[0].output, "---NEW---");

      // 断言：丢弃日志被记录
      const ignoredLog = warnings.find((w) => w.includes("忽略过时的评测结果"));
      assertExists(ignoredLog, "应记录旧结果被丢弃的日志");
    } finally {
      await db.delete(evaluationResults).where(
        eq(evaluationResults.submission_id, subId),
      );
      await db.delete(submissions).where(eq(submissions.id, subId));
      await db.delete(users).where(eq(users.id, userId));
    }
  },
});

// ── 审计日志埋点测试 ──
//
// rejudgeSubmission / rejudgeProblemSubmissions 都会调用 pushJudgeTask，
// PGlite 模式下没有 Redis，因此启动 fake Redis（极简 RESP 服务器）让
// pushJudgeTask 的 LPUSH 调用不会失败。
// 同时 resetDbForTest() 会清空模块级 setup 测试创建的 TEST_USER_ID/
// TEST_PROBLEM_ID，因此这里为每个测试独立创建本地 fixture。

import { getRedis, resetRedisForTest } from "../../src/mq/connection.ts";

Deno.test({
  name:
    "submissions service: rejudgeSubmission 写一条 submissions.rejudge 审计",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    resetRedisForTest();

    // 启动 fake Redis，让 pushJudgeTask 走完整 LPUSH 路径
    const fakeRedis = await startFakeRedis();
    Deno.env.set("REDIS_URL", fakeRedis.url);

    // 触发 ioredis 单例的 connect + PING，让状态从 wait 转为 ready
    // 否则 pushJudgeTask 在 status 检查时就抛错
    const redis = getRedis();
    await redis.connect();
    await redis.ping();
    try {
      // 准备：admin 操作者 + 本地用户 + 本地题目（满足所有 FK）
      const db = getDb();
      const adminId = crypto.randomUUID();
      const localUserId = crypto.randomUUID();
      const localProblemId = crypto.randomUUID();
      const now = new Date().toISOString();
      await db.insert(users).values([
        {
          id: adminId,
          username: `test-rej-sub-admin-${Date.now()}`,
          email: `test-rej-sub-admin-${Date.now()}@example.com`,
          password_hash: "",
          role: "admin",
          created_at: now,
          updated_at: now,
        },
        {
          id: localUserId,
          username: `test-rej-sub-user-${Date.now()}`,
          email: `test-rej-sub-user-${Date.now()}@example.com`,
          password_hash: "",
          role: "user",
          created_at: now,
          updated_at: now,
        },
      ]);
      await db.insert(problems).values({
        id: localProblemId,
        title: `重测审计题 ${Date.now()}`,
        description: "rejudgeSubmission 审计测试用题目",
        difficulty: "easy",
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            command: "python3 /workspace/evaluate.py",
            time_limit_ms: 5000,
            memory_limit_mb: 512,
          },

          solution: {
            image: "noj-solution-python",
            entry: "submission_sample.py",
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
        number: 60000 + (Date.now() & 0x7fff),
        owner_id: adminId,
        type: "U",
        created_at: now,
        updated_at: now,
      });

      // 注入 admin actor context（logAudit 依赖 RequestContext）
      enterTestContext({
        actorId: adminId,
        actorIp: "10.0.0.55",
        actorRole: "admin",
      });

      // 准备：一条 finished 状态的提交（重测只接受已存在的 submission）
      const subId = crypto.randomUUID();
      await db.insert(submissions).values({
        id: subId,
        user_id: localUserId,
        problem_id: localProblemId,
        language: "python3",
        code: "print(1)",
        file_name: "main.py",
        status: "finished",
        rejudge_seq: 0,
        created_at: now,
      });
      await db.insert(evaluationResults).values({
        id: crypto.randomUUID(),
        submission_id: subId,
        status: "Accepted",
        score: 1000,
        output: "---RESULT---",
        details: "{}",
        created_at: now,
      });

      // 清空本测试前可能存在的审计行，避免行数偏差
      await db.delete(auditLogs);

      try {
        // 执行：单条重测
        await rejudgeSubmission(subId);

        // 验证：审计日志写入
        const rows = await db.select().from(auditLogs).where(
          eq(auditLogs.action, "submissions.rejudge"),
        );
        assertEquals(rows.length, 1);
        assertEquals(rows[0].target_type, "submission");
        assertEquals(rows[0].target_id, subId);
        assertEquals(rows[0].admin_id, adminId);
        assertEquals(rows[0].ip_address, "10.0.0.55");
        const detail = rows[0].detail as {
          action: string;
          submission_id?: string;
          problem_id?: string;
          count?: number;
        };
        assertEquals(detail.action, "submissions.rejudge");
        assertEquals(detail.submission_id, subId);
        assertEquals(detail.problem_id, undefined);
        assertEquals(detail.count, undefined);
      } finally {
        // 清理本测试数据
        await db.delete(evaluationResults).where(
          eq(evaluationResults.submission_id, subId),
        );
        await db.delete(submissions).where(eq(submissions.id, subId));
        await db.delete(auditLogs).where(eq(auditLogs.admin_id, adminId));
        await db.delete(problems).where(eq(problems.id, localProblemId));
        await db.delete(users).where(eq(users.id, adminId));
        await db.delete(users).where(eq(users.id, localUserId));
      }
    } finally {
      await fakeRedis.stop();
      Deno.env.delete("REDIS_URL");
    }
  },
});

Deno.test({
  name:
    "submissions service: rejudgeProblemSubmissions 写一条 submissions.rejudge 审计",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    resetRedisForTest();

    // 启动 fake Redis
    const fakeRedis = await startFakeRedis();
    Deno.env.set("REDIS_URL", fakeRedis.url);

    // 触发 ioredis 单例的 connect + PING
    const redis2 = getRedis();
    await redis2.connect();
    await redis2.ping();
    try {
      // 准备：admin 操作者 + 本地用户 + 本地题目
      const db = getDb();
      const adminId = crypto.randomUUID();
      const localUserId = crypto.randomUUID();
      const localProblemId = crypto.randomUUID();
      const now = new Date().toISOString();
      await db.insert(users).values([
        {
          id: adminId,
          username: `test-rej-prb-admin-${Date.now()}`,
          email: `test-rej-prb-admin-${Date.now()}@example.com`,
          password_hash: "",
          role: "admin",
          created_at: now,
          updated_at: now,
        },
        {
          id: localUserId,
          username: `test-rej-prb-user-${Date.now()}`,
          email: `test-rej-prb-user-${Date.now()}@example.com`,
          password_hash: "",
          role: "user",
          created_at: now,
          updated_at: now,
        },
      ]);
      await db.insert(problems).values({
        id: localProblemId,
        title: `批量重测审计题 ${Date.now()}`,
        description: "rejudgeProblemSubmissions 审计测试用题目",
        difficulty: "easy",
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            command: "python3 /workspace/evaluate.py",
            time_limit_ms: 5000,
            memory_limit_mb: 512,
          },

          solution: {
            image: "noj-solution-python",
            entry: "submission_sample.py",
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
        number: 61000 + (Date.now() & 0x7fff),
        owner_id: adminId,
        type: "U",
        created_at: now,
        updated_at: now,
      });

      // 注入 admin actor context
      enterTestContext({
        actorId: adminId,
        actorIp: "10.0.0.66",
        actorRole: "admin",
      });

      // 准备：3 条 finished 状态的提交（同题）
      const subIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const sid = crypto.randomUUID();
        subIds.push(sid);
        await db.insert(submissions).values({
          id: sid,
          user_id: localUserId,
          problem_id: localProblemId,
          language: "python3",
          code: `print(${i})`,
          file_name: "main.py",
          status: "finished",
          rejudge_seq: 0,
          created_at: now,
        });
        await db.insert(evaluationResults).values({
          id: crypto.randomUUID(),
          submission_id: sid,
          status: "Accepted",
          score: 1000,
          output: "---RESULT---",
          details: "{}",
          created_at: now,
        });
      }

      // 清空本测试前可能存在的审计行
      await db.delete(auditLogs);

      try {
        // 执行：批量重测
        const result = await rejudgeProblemSubmissions(localProblemId);
        assertEquals(result.total, 3);

        // 验证：审计日志写入
        const rows = await db.select().from(auditLogs).where(
          eq(auditLogs.action, "submissions.rejudge"),
        );
        assertEquals(rows.length, 1);
        assertEquals(rows[0].target_type, "problem");
        assertEquals(rows[0].target_id, localProblemId);
        assertEquals(rows[0].admin_id, adminId);
        assertEquals(rows[0].ip_address, "10.0.0.66");
        const detail = rows[0].detail as {
          action: string;
          submission_id?: string;
          problem_id?: string;
          count?: number;
        };
        assertEquals(detail.action, "submissions.rejudge");
        assertEquals(detail.problem_id, localProblemId);
        assertEquals(detail.count, 3);
        assertEquals(detail.submission_id, undefined);
      } finally {
        // 清理本测试数据
        for (const sid of subIds) {
          await db.delete(evaluationResults).where(
            eq(evaluationResults.submission_id, sid),
          );
          await db.delete(submissions).where(eq(submissions.id, sid));
        }
        await db.delete(auditLogs).where(eq(auditLogs.admin_id, adminId));
        await db.delete(problems).where(eq(problems.id, localProblemId));
        await db.delete(users).where(eq(users.id, adminId));
        await db.delete(users).where(eq(users.id, localUserId));
      }
    } finally {
      await fakeRedis.stop();
      Deno.env.delete("REDIS_URL");
    }
  },
});

// ── PR-3 评审修订：状态机转换表测试 ─────────────────────
//
// 覆盖 VALID_TRANSITIONS 的关键边界：
// - 合法转换：pending → judging → finished
// - 非法转换：pending → finished（跳过 judging 应抛错）
// - 非法转换：judging → pending（不可回退）
// - 非法转换：finished → 任意（终态）
// - 不存在的 submission_id 抛 NotFoundError

Deno.test({
  name:
    "updateSubmissionStatus: 合法转换 pending → judging 设置 judge_started_at",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const { randomUUID } = await import("node:crypto");
    const userId = randomUUID();
    const problemId = randomUUID();
    await db.insert(users).values({
      id: userId,
      username: `state_test_${Date.now()}`,
      email: `st_${Date.now()}@e.com`,
      password_hash: "x",
      role: "user",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await db.insert(problems).values({
      id: problemId,
      type: "U",
      number: 99999,
      title: "T",
      description: "test",
      difficulty: "easy",
      owner_id: userId,
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },
        solution: {
          image: "noj-solution-python",
          entry: "submission_sample.py",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const subId = randomUUID();
    await db.insert(submissions).values({
      id: subId,
      user_id: userId,
      problem_id: problemId,
      language: "python3",
      code: "x",
      status: "pending",
      created_at: new Date().toISOString(),
    });
    await updateSubmissionStatus(subId, "judging");
    const [row] = await db.select().from(submissions).where(
      eq(submissions.id, subId),
    ).limit(1);
    assertEquals(row.status, "judging");
    assertExists(row.judge_started_at);
  },
});

Deno.test({
  name:
    "updateSubmissionStatus: 非法转换 pending → finished 应抛 BadRequestError",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const { randomUUID } = await import("node:crypto");
    const userId = randomUUID();
    const problemId = randomUUID();
    await db.insert(users).values({
      id: userId,
      username: `state_test2_${Date.now()}`,
      email: `st2_${Date.now()}@e.com`,
      password_hash: "x",
      role: "user",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await db.insert(problems).values({
      id: problemId,
      type: "U",
      number: 99998,
      title: "T",
      description: "test",
      difficulty: "easy",
      owner_id: userId,
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },
        solution: {
          image: "noj-solution-python",
          entry: "submission_sample.py",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const subId = randomUUID();
    await db.insert(submissions).values({
      id: subId,
      user_id: userId,
      problem_id: problemId,
      language: "python3",
      code: "x",
      status: "pending",
      created_at: new Date().toISOString(),
    });
    await assertRejects(
      () => updateSubmissionStatus(subId, "finished"),
      BadRequestError,
      "无效的状态转换",
    );
  },
});

Deno.test({
  name: "updateSubmissionStatus: finished 终态无法再转换",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const { randomUUID } = await import("node:crypto");
    const userId = randomUUID();
    const problemId = randomUUID();
    await db.insert(users).values({
      id: userId,
      username: `state_test3_${Date.now()}`,
      email: `st3_${Date.now()}@e.com`,
      password_hash: "x",
      role: "user",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await db.insert(problems).values({
      id: problemId,
      type: "U",
      number: 99997,
      title: "T",
      description: "test",
      difficulty: "easy",
      owner_id: userId,
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },
        solution: {
          image: "noj-solution-python",
          entry: "submission_sample.py",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const subId = randomUUID();
    await db.insert(submissions).values({
      id: subId,
      user_id: userId,
      problem_id: problemId,
      language: "python3",
      code: "x",
      status: "finished",
      created_at: new Date().toISOString(),
    });
    // 终态 → 任意都应抛错
    await assertRejects(
      () => updateSubmissionStatus(subId, "judging"),
      BadRequestError,
    );
    await assertRejects(
      () => updateSubmissionStatus(subId, "pending"),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "updateSubmissionStatus: 不存在的 submission_id 抛 NotFoundError",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () =>
        updateSubmissionStatus(
          "00000000-0000-0000-0000-000000000000",
          "judging",
        ),
      NotFoundError,
      "提交不存在",
    );
  },
});
