/**
 * 竞赛代码相似度检测测试。
 *
 * 覆盖三层：
 * 1. 纯函数（归一化 / 指纹 / Jaccard / 配对）——无需数据库；
 * 2. 查询服务（取数口径、分桶、规模上限）——需要数据库；
 * 3. 管理端路由（权限、参数校验、响应结构）——需要数据库。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  contests,
  problems,
  submissions,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import {
  BadRequestError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { createApp } from "../../../../app.ts";
import { signToken } from "../../../identity/index.ts";
import { ensureRbacSeeds } from "../../../system/index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import {
  detectSimilarPairs,
  findSimilarSubmissions,
  fingerprint,
  normalizeCode,
  similarity,
} from "../../index.ts";

// 测试进程通常没有本地 Redis；短路 JWT 撤销检查，避免 authMiddleware 503。
Deno.env.set("NOJ_BYPASS_JWT_REVOKE", "1");
await resetDbForTest();
// 路由用例需要 admin:full_access 与 contest:anti_cheat_read 权限种子。
await ensureRbacSeeds();

/** 冒泡排序解法（原始写法）。 */
const BUBBLE_SOLUTION = `def solve(n, nums):
    # 冒泡排序，把较大的元素逐步交换到末尾
    for i in range(n):
        for j in range(0, n - i - 1):
            if nums[j] > nums[j + 1]:
                nums[j], nums[j + 1] = nums[j + 1], nums[j]
    return nums
`;

/** 与 BUBBLE_SOLUTION 等价，但改名 + 改注释 + 改空白（典型抄袭特征）。 */
const BUBBLE_RENAMED = `def bubble_sort(count, arr):
    """另一种写法的冒泡排序"""

    for idx in range(count):
        for k in range(0, count - idx - 1):
            if arr[k] > arr[k + 1]:
                arr[k], arr[k + 1] = arr[k + 1], arr[k]

    return arr
`;

/** 同一道题的另一份真实不同的实现（计数排序，结构完全不同）。 */
const COUNTING_SOLUTION = `def solve(count, values):
    table = {}
    for item in values:
        table[item] = table.get(item, 0) + 1
    output = []
    for key in sorted(table):
        output.extend([key] * table[key])
    return output
`;

/** 构造纯函数用例的候选提交。 */
function candidate(
  overrides: Partial<Parameters<typeof detectSimilarPairs>[0][number]> & {
    submission_id: string;
  },
) {
  return {
    user_id: "user-1",
    problem_id: "problem-1",
    language: "python",
    code: null as string | null,
    ...overrides,
  };
}

Deno.test({
  name: "contest similarity: 归一化消除注释/空白/字符串与变量名差异",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const original = normalizeCode(BUBBLE_SOLUTION, "python");
    const renamed = normalizeCode(BUBBLE_RENAMED, "python");
    // 改名 + 注释 + 文档字符串 + 空白差异全部被抹平 → token 序列完全一致
    assertEquals(renamed, original);

    // 仅空白不同
    assertEquals(
      normalizeCode("x = 1\ny=2", "python"),
      normalizeCode("x  =  1\n\n\n y = 2", "python"),
    );
    // 仅注释不同
    assertEquals(
      normalizeCode("x = 1 # 加一\n# 注释行\ny = 2", "python"),
      normalizeCode("x = 1\ny = 2", "python"),
    );
    // 仅字符串字面量内容不同
    assertEquals(
      normalizeCode('print("hello world")', "python"),
      normalizeCode("print('totally different text')", "python"),
    );
    // 数字字面量刻意**不**归一化（常量是区分不同实现的信号）
    assertEquals(
      normalizeCode("print(1)", "python") ===
        normalizeCode("print(2)", "python"),
      false,
    );
    // 字符串里的 // 不能把后面的真实代码当注释吃掉
    assertEquals(
      normalizeCode('url = "http://x" + str(1)', "cpp").length > 0,
      true,
    );
    // 标识符改写是位置化的：同一变量多次出现映射到同一个占位符
    assertEquals(normalizeCode("total = total + total", "python"), [
      "v1",
      "=",
      "v1",
      "+",
      "v1",
    ]);
  },
});

Deno.test({
  name: "contest similarity: 指纹与 Jaccard 的基本性质",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const tokens = normalizeCode(BUBBLE_SOLUTION, "python");
    const prints = fingerprint(tokens);
    assert(prints.length > 0);
    // 去重
    assertEquals(new Set(prints).size, prints.length);
    // 长度不足 k 的 token 流产生不了指纹
    assertEquals(fingerprint(["print", "(", "1", ")"]), []);
    // 空集合相似度为 0（不是 1），避免「空提交互判 100% 相似」
    assertEquals(similarity([], []), 0);
    assertEquals(similarity([], prints), 0);
    // 自身比较为 1；完全不相交为 0
    assertEquals(similarity(prints, prints), 1);
    assertEquals(similarity(prints, [12345, 67890]), 0);
    // 参数非法时抛 AppError 体系错误，而不是裸 Error
    let invalidK: unknown;
    try {
      fingerprint(tokens, 0);
    } catch (err) {
      invalidK = err;
    }
    assert(invalidK instanceof BadRequestError);
  },
});

Deno.test({
  name: "contest similarity: 雷同命中、不同实现不误报",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const clone = candidate({
      submission_id: "sub-clone",
      code: BUBBLE_RENAMED,
    });
    const original = candidate({
      submission_id: "sub-original",
      user_id: "user-2",
      code: BUBBLE_SOLUTION,
    });
    const other = candidate({
      submission_id: "sub-other",
      user_id: "user-3",
      code: COUNTING_SOLUTION,
    });

    const cloneScore = similarity(
      fingerprint(normalizeCode(BUBBLE_SOLUTION, "python")),
      fingerprint(normalizeCode(BUBBLE_RENAMED, "python")),
    );
    const falsePositiveScore = similarity(
      fingerprint(normalizeCode(BUBBLE_SOLUTION, "python")),
      fingerprint(normalizeCode(COUNTING_SOLUTION, "python")),
    );
    // 雷同：改名/注释/空白差异后仍应几乎相同
    assert(cloneScore > 0.95, `clone score=${cloneScore}`);
    // 不同实现：必须明显低于默认阈值 0.8
    assert(falsePositiveScore < 0.5, `other score=${falsePositiveScore}`);

    const pairs = detectSimilarPairs([clone, original, other]);
    assertEquals(pairs.length, 1);
    assertEquals(pairs[0]?.submission_a_id, "sub-clone");
    assertEquals(pairs[0]?.submission_b_id, "sub-original");
    assertEquals(pairs[0]?.similarity, 1);
    assertEquals(pairs[0]?.language, "python");
    assertEquals(pairs[0]?.problem_id, "problem-1");
  },
});

Deno.test({
  name: "contest similarity: 边界（空代码/极短/null/单提交/同用户/跨题跨语言）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    assertEquals(normalizeCode(null, "python"), []);
    assertEquals(normalizeCode(undefined, "python"), []);
    assertEquals(normalizeCode("", "python"), []);
    assertEquals(normalizeCode("   \n\t ", "python"), []);
    assertEquals(normalizeCode("# 只有注释\n", "python"), []);

    const empty = candidate({ submission_id: "sub-empty", code: "" });
    const nullCode = candidate({
      submission_id: "sub-null",
      user_id: "user-2",
      code: null,
    });
    const short = candidate({
      submission_id: "sub-short",
      user_id: "user-3",
      code: "print(1)",
    });
    const single = candidate({
      submission_id: "sub-single",
      code: BUBBLE_SOLUTION,
    });

    // 空/null/极短代码不产生任何相似对
    assertEquals(detectSimilarPairs([empty, nullCode, short]), []);
    // 单个提交没有可比较的对象
    assertEquals(detectSimilarPairs([single]), []);

    const shared = candidate({ submission_id: "sub-a", code: BUBBLE_SOLUTION });
    const sameUser = candidate({
      submission_id: "sub-b",
      code: BUBBLE_RENAMED,
    });
    const crossUser = candidate({
      submission_id: "sub-c",
      user_id: "user-2",
      code: BUBBLE_RENAMED,
    });
    const crossProblem = candidate({
      submission_id: "sub-d",
      user_id: "user-3",
      problem_id: "problem-2",
      code: BUBBLE_RENAMED,
    });
    const crossLanguage = candidate({
      submission_id: "sub-e",
      user_id: "user-4",
      language: "cpp",
      code: BUBBLE_RENAMED,
    });

    // 默认跳过同一用户的两次提交（本人重交不是抄袭线索）
    const withSkip = detectSimilarPairs([
      shared,
      sameUser,
      crossUser,
      crossProblem,
      crossLanguage,
    ]);
    assertEquals(withSkip.length, 2);
    assert(withSkip.every((pair) => pair.user_a_id !== pair.user_b_id));
    assert(withSkip.every((pair) => pair.problem_id === "problem-1"));
    assert(withSkip.every((pair) => pair.language === "python"));

    // 关闭该开关后同用户对也会被列出（3 对）
    assertEquals(
      detectSimilarPairs(
        [shared, sameUser, crossUser, crossProblem, crossLanguage],
        { skipSameUser: false },
      ).length,
      3,
    );
  },
});

Deno.test({
  name: "contest similarity: limit 截断与相似度降序",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    // 3 份冒泡排序变体（1 份原始 / 1 份改名 / 1 份改一个常量）+ 2 份计数排序
    // 变体，两两之间都在 0.5 阈值以上，用来验证 limit 截断与降序。
    const candidates = [
      candidate({ submission_id: "s1", code: BUBBLE_SOLUTION }),
      candidate({ submission_id: "s2", user_id: "u2", code: BUBBLE_RENAMED }),
      candidate({
        submission_id: "s3",
        user_id: "u3",
        code: BUBBLE_SOLUTION.replace("n - i - 1", "n - i - 2"),
      }),
      candidate({
        submission_id: "s4",
        user_id: "u4",
        code: COUNTING_SOLUTION,
      }),
      candidate({
        submission_id: "s5",
        user_id: "u5",
        code: COUNTING_SOLUTION.replace("table[item]", "table[item] + 0"),
      }),
    ];
    const all = detectSimilarPairs(candidates, { threshold: 0.5, limit: 200 });
    const limited = detectSimilarPairs(candidates, {
      threshold: 0.5,
      limit: 2,
    });
    assertEquals(limited.length, 2);
    assert(all.length > 2, `all=${all.length}`);
    // 降序 + 顶部一致
    assertEquals(limited[0]?.similarity, all[0]?.similarity);
    for (let i = 1; i < all.length; i++) {
      assert(all[i - 1]!.similarity >= all[i]!.similarity);
    }
  },
});

/** 四类结构互不相同的合成解法，用于规模与性能用例。 */
const SYNTHETIC_FAMILIES: readonly ((
  names: Record<string, string>,
  salt: number,
) => string)[] = [
  (n, salt) =>
    `def ${n.fn}(${n.data}):
    ${n.acc} = 0
    for ${n.item} in ${n.data}:
        if ${n.item} % ${salt + 3} == 0:
            ${n.acc} += ${n.item}
        elif ${n.item} > ${salt * 7}:
            ${n.acc} -= ${salt}
    return ${n.acc}
`,
  (n, salt) =>
    `def ${n.fn}(${n.data}):
    ${n.table} = {}
    for ${n.item} in ${n.data}:
        ${n.table}[${n.item}] = ${n.table}.get(${n.item}, ${salt}) + 1
    return [${n.key} for ${n.key} in sorted(${n.table}) if ${n.table}[${n.key}] > ${salt}]
`,
  (n, salt) =>
    `def ${n.fn}(${n.data}):
    if not ${n.data}:
        return ${salt}
    ${n.head} = ${n.data}[0]
    ${n.tail} = ${n.data}[1:]
    return ${n.head} + ${n.fn}(${n.tail}) + ${salt}
`,
  (n, salt) =>
    `def ${n.fn}(${n.data}):
    ${n.out} = []
    for ${n.item} in ${n.data}:
        ${n.out}.append(str(${n.item}) * ${salt + 1})
    return "+".join(${n.out})[:${salt * 3}]
`,
];

/** 合成第 index 份提交：家族内仅常量不同，家族间结构不同。 */
function syntheticSolution(index: number): string {
  const family = SYNTHETIC_FAMILIES[index % SYNTHETIC_FAMILIES.length]!;
  const names = {
    fn: "solve",
    data: "data",
    acc: "acc",
    item: "item",
    table: "table",
    key: "key",
    head: "head",
    tail: "tail",
    out: "out",
  };
  return family(names, index * 13 + 1);
}

/** 把解法里的标识符整体改名，模拟「改个名字就交」的抄袭手法。 */
function renameIdentifiers(code: string, suffix: string): string {
  return code
    .replaceAll("solve", `run${suffix}`)
    .replaceAll("data", `payload${suffix}`)
    .replaceAll("acc", `total${suffix}`)
    .replaceAll("item", `unit${suffix}`)
    .replaceAll("table", `bag${suffix}`)
    .replaceAll("key", `slot${suffix}`)
    .replaceAll("head", `first${suffix}`)
    .replaceAll("tail", `rest${suffix}`)
    .replaceAll("out", `result${suffix}`);
}

Deno.test({
  name: "contest similarity: 100 份提交的性能与命中",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const clones = Array.from(
      { length: 99 },
      (_, index) => syntheticSolution(index),
    );
    // 第 100 份是第 1 份的改名副本（含注释/空白扰动）
    clones.push(
      `# 我的解法\n${renameIdentifiers(syntheticSolution(0), "X")}\n`,
    );
    const candidates = clones.map((code, index) =>
      candidate({
        submission_id: `perf-${index}`,
        user_id: `perf-user-${index}`,
        code,
      })
    );

    const startedAt = performance.now();
    const pairs = detectSimilarPairs(candidates, { threshold: 0.8 });
    const elapsedMs = performance.now() - startedAt;
    // 仅用于人工观察基线，不断言具体数值（避免脆弱断言）
    console.log(
      `[perf] 100 份提交 / ${pairs.length} 对命中 / 耗时 ${
        elapsedMs.toFixed(1)
      }ms`,
    );
    // 宽松上界：本地实测远低于此值，仅防性能回归到分钟级
    assert(elapsedMs < 5000, `elapsed=${elapsedMs}ms`);

    const clonePair = pairs.find((pair) =>
      pair.submission_a_id === "perf-0" && pair.submission_b_id === "perf-99"
    );
    assert(clonePair, "第 100 份改名副本未被检出");
    assert(clonePair.similarity >= 0.8);
  },
});

Deno.test({
  name: "contest similarity: 查询服务与路由（取数口径/规模上限/参数校验/权限）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await initRedisForTest();
    const db = getDb();
    const now = new Date().toISOString();
    const contestId = crypto.randomUUID();
    const adminId = crypto.randomUUID();
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    const userC = crypto.randomUUID();
    const problemA = crypto.randomUUID();
    const problemB = crypto.randomUUID();
    const suffix = crypto.randomUUID().slice(0, 8);
    await db.insert(users).values([
      {
        id: adminId,
        username: `sim-admin-${suffix}`,
        email: `sim-admin-${suffix}@example.com`,
        password_hash: "hash",
        created_at: now,
        updated_at: now,
      },
      {
        id: userA,
        username: `sim-a-${suffix}`,
        email: `sim-a-${suffix}@example.com`,
        password_hash: "hash",
        created_at: now,
        updated_at: now,
      },
      {
        id: userB,
        username: `sim-b-${suffix}`,
        email: `sim-b-${suffix}@example.com`,
        password_hash: "hash",
        created_at: now,
        updated_at: now,
      },
      {
        id: userC,
        username: `sim-c-${suffix}`,
        email: `sim-c-${suffix}@example.com`,
        password_hash: "hash",
        created_at: now,
        updated_at: now,
      },
    ]);
    await db.insert(userRoles).values({ user_id: adminId, role_id: "admin" });
    await db.insert(problems).values([
      {
        id: problemA,
        title: "相似度测试题 A",
        description: "",
        difficulty: "easy",
        runtime_config: {},
        number: 981001,
        owner_id: adminId,
        type: "P",
        created_at: now,
        updated_at: now,
      },
      {
        id: problemB,
        title: "相似度测试题 B",
        description: "",
        difficulty: "easy",
        runtime_config: {},
        number: 981002,
        owner_id: adminId,
        type: "P",
        created_at: now,
        updated_at: now,
      },
    ]);
    await db.insert(contests).values({
      id: contestId,
      public_id: `ct-sim-${suffix}`,
      title: "相似度测试赛",
      description: "",
      start_time: new Date(Date.now() - 1000).toISOString(),
      end_time: new Date(Date.now() + 3600000).toISOString(),
      type: "kaggle",
      config: {},
      is_public: true,
      password: null,
      affect_global_ranking: false,
      created_by: adminId,
      announcement: "",
      created_at: now,
      updated_at: now,
    });

    /** 造一条提交；`overrides` 覆盖默认值。 */
    const submissionRow = (
      overrides: Record<string, unknown>,
    ): Record<string, unknown> => ({
      id: crypto.randomUUID(),
      public_id: `sub-sim-${crypto.randomUUID().slice(0, 8)}`,
      user_id: userA,
      problem_id: problemA,
      contest_id: contestId,
      language: "python",
      code: BUBBLE_SOLUTION,
      file_name: "main.py",
      status: "finished",
      created_at: now,
      ...overrides,
    });

    const earlier = new Date(Date.now() - 60000).toISOString();
    const rows = [
      // 0/1：跨用户雷同对（应当命中）
      submissionRow({ public_id: "sub-sim-a", created_at: earlier }),
      submissionRow({
        public_id: "sub-sim-b",
        user_id: userB,
        code: BUBBLE_RENAMED,
      }),
      // 2：与 0 同一用户的相同代码（应因 skipSameUser 跳过）
      submissionRow({ public_id: "sub-sim-c", code: BUBBLE_RENAMED }),
      // 3：不同实现（不应命中）
      submissionRow({
        public_id: "sub-sim-d",
        user_id: userC,
        code: COUNTING_SOLUTION,
      }),
      // 4：同代码但不同题目（不应命中）
      submissionRow({
        public_id: "sub-sim-e",
        user_id: userB,
        problem_id: problemB,
      }),
      // 5：同代码但不同语言（不应命中）
      submissionRow({
        public_id: "sub-sim-f",
        user_id: userC,
        language: "cpp",
      }),
      // 6：artifact 提交（code 为空串 + 存储 URL，应被排除）
      submissionRow({
        public_id: "sub-sim-artifact",
        user_id: userC,
        code: "",
        artifact_storage_url: "noj-storage://artifacts/demo.zip",
      }),
      // 7：未到终态（应被排除）
      submissionRow({
        public_id: "sub-sim-judging",
        user_id: userB,
        status: "judging",
      }),
      // 8：只有空白（应被排除）
      submissionRow({
        public_id: "sub-sim-blank",
        user_id: userC,
        code: " \n ",
      }),
      // 9：极短代码（进入候选但产生不了指纹）
      submissionRow({
        public_id: "sub-sim-short",
        user_id: userC,
        code: "print(1)",
      }),
    ];
    await db.insert(submissions).values(rows as never);

    const result = await findSimilarSubmissions(contestId, { threshold: 0.8 });
    // 候选 = 通过「finished + 非 artifact + 非空白」过滤的行：0,1,2,3,4,5,9
    assertEquals(result.candidates, 7);
    assertEquals(result.buckets, 3);
    assertEquals(result.threshold, 0.8);
    assertEquals(result.limit, 50);
    // 默认提交数上限（规模保护），取值依据见 DEFAULT_MAX_SIMILARITY_SUBMISSIONS
    assertEquals(result.max_submissions, 200);
    // 命中：(a,b) 与 (c,b)，同一用户的 (a,c) 被跳过
    assertEquals(result.data.length, 2);
    assert(result.data.every((pair) => pair.user_a_id !== pair.user_b_id));
    assert(result.data.every((pair) => pair.problem_id === problemA));
    assert(result.data.every((pair) => pair.language === "python"));
    const top = result.data[0]!;
    assertEquals(top.similarity, 1);
    assertEquals(top.submission_a_id, "sub-sim-a");
    assertEquals(top.submitted_at_a, earlier);
    assert(top.username_a?.startsWith("sim-a-") === true);
    assert(top.shared_fingerprints > 0);
    assertEquals(result.truncated, false);

    // 单题过滤：只算题目 B → 没有可配对的对象
    const problemOnly = await findSimilarSubmissions(contestId, {
      problemId: problemB,
    });
    assertEquals(problemOnly.candidates, 1);
    assertEquals(problemOnly.data.length, 0);

    // 高阈值（1）时只剩完全一致的对，且 limit 生效
    const strict = await findSimilarSubmissions(contestId, {
      threshold: 1,
      limit: 1,
    });
    assertEquals(strict.data.length, 1);
    assertEquals(strict.total, 2);
    assertEquals(strict.truncated, true);

    // 规模上限：题目 A 有 5 条候选，上限设为 3 时必须明确报错而不是静默截断
    let scaleError: unknown;
    try {
      await findSimilarSubmissions(contestId, {
        problemId: problemA,
        maxSubmissions: 3,
      });
    } catch (err) {
      scaleError = err;
    }
    assert(scaleError instanceof BadRequestError);
    assertEquals(
      (scaleError as BadRequestError).code,
      "SIMILARITY_SCALE_EXCEEDED",
    );

    // 竞赛不存在 → NotFoundError（与同域风控端点语义一致）
    let notFound: unknown;
    try {
      await findSimilarSubmissions(crypto.randomUUID());
    } catch (err) {
      notFound = err;
    }
    assert(notFound instanceof NotFoundError);

    const app = createApp();
    const adminToken = await signToken({ sub: adminId, role: "admin" });
    const response = await jsonRequest(
      app,
      `/api/v1/admin/contest/contests/${contestId}/anti-cheat/similar-submissions`,
      { token: adminToken },
    );
    assertEquals(response.status, 200);
    const body = await response.json() as {
      data: Record<string, unknown>[];
      meta: Record<string, unknown>;
      data_policy: Record<string, unknown>;
    };
    assertEquals(body.data.length, 2);
    assertEquals(body.meta.threshold, 0.8);
    assertEquals(body.meta.candidates, 7);
    assertEquals(body.meta.truncated, false);
    assertEquals(body.data_policy.automated_penalty, false);
    // 不返回源代码本身
    assertEquals("code" in body.data[0]!, false);
    assertEquals(JSON.stringify(body).includes("nums[j]"), false);

    // 阈值/条数参数校验
    for (
      const query of [
        "threshold=0",
        "threshold=1.5",
        "threshold=abc",
        "limit=0",
        "limit=201",
        "limit=2.5",
      ]
    ) {
      const bad = await jsonRequest(
        app,
        `/api/v1/admin/contest/contests/${contestId}/anti-cheat/similar-submissions?${query}`,
        { token: adminToken },
      );
      assertEquals(bad.status, 400, `query=${query}`);
    }

    // 合法参数：阈值与条数被回显
    const ok = await jsonRequest(
      app,
      `/api/v1/admin/contest/contests/${contestId}/anti-cheat/similar-submissions?threshold=0.9&limit=5&problem_id=${problemA}`,
      { token: adminToken },
    );
    assertEquals(ok.status, 200);
    const okBody = await ok.json() as { meta: Record<string, unknown> };
    assertEquals(okBody.meta.threshold, 0.9);
    assertEquals(okBody.meta.limit, 5);

    // 权限：普通用户 403（与既有风控端点同一权限口径）
    const userToken = await signToken({ sub: userC, role: "user" });
    const forbidden = await jsonRequest(
      app,
      `/api/v1/admin/contest/contests/${contestId}/anti-cheat/similar-submissions`,
      { token: userToken },
    );
    assertEquals(forbidden.status, 403);
  },
});
