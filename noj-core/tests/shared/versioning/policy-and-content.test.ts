/**
 * 内容模型与有效版本策略的纯函数测试（Handbook §2.2、§2.3、§1.2）。
 *
 * 内容哈希的稳定性是"相同内容不制造空版本"的前提：字段书写顺序、对象键顺序、
 * 文件枚举顺序都不能影响哈希；而任一字节内容变化必须改变哈希。
 *
 * 注意：`@std/assert` 的 `assertRejects` **只接受返回 rejected promise 的函数**，
 * 同步 throw 需包在 `async () => { ... }` 中，否则会得到
 * "Function throws when expected to reject"（本项目曾因此踩坑）。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  assertContentKindTransition,
  canonicalJson,
  computeProblemContentHash,
  problemContentKindOf,
  validateProblemContent,
} from "../../../src/domains/catalog/types/problem-content.ts";
import {
  isPolicyCoherent,
  resolveContestAnswerVersion,
  resolveDefaultAnswerVersion,
} from "../../../src/shared/versioning/policy.ts";
import {
  policyFromColumns,
  policyToColumns,
} from "../../../src/shared/versioning/types.ts";

const runtimeConfig = {
  evaluator: {
    image: "noj/evaluator:test",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 60000,
    memory_limit_mb: 512,
  },
  solution: {
    image: "noj/solution:test",
    call_timeout_ms: 60000,
    memory_limit_mb: 512,
  },
};

function aiContent(overrides: Record<string, unknown> = {}) {
  return {
    kind: "ai" as const,
    title: "标题",
    description: "题面",
    samples: [{ id: "s1", input: "1", output: "2" }],
    submission_mode: "code" as const,
    runtime_config: runtimeConfig,
    template_content: "print(1)",
    artifact_max_size_mb: null,
    llm_config: null,
    ...overrides,
  };
}

/** 断言同步校验函数抛错（包成 rejected promise 以满足 assertRejects 契约）。 */
async function assertThrows(fn: () => unknown): Promise<void> {
  await assertRejects(() => {
    try {
      fn();
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve();
  });
}

Deno.test("content: 题目身份 → 内容类别", () => {
  assertEquals(
    problemContentKindOf({ is_objective: true, judge_type: "dual" }),
    "objective",
  );
  assertEquals(
    problemContentKindOf({ is_objective: false, judge_type: "oi" }),
    "oi",
  );
  assertEquals(
    problemContentKindOf({ is_objective: false, judge_type: "dual" }),
    "ai",
  );
});

Deno.test("content: canonicalJson 对键顺序稳定、丢弃 undefined", () => {
  assertEquals(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assertEquals(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assertEquals(canonicalJson([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
  assertEquals(canonicalJson(null), "null");
});

Deno.test("content: 哈希只看内容与文件哈希，与枚举顺序无关", async () => {
  const a = aiContent();
  const b = {
    ...aiContent(),
    samples: [{ output: "2", id: "s1", input: "1" }],
  };
  // 样例对象键顺序不同但语义相同
  assertEquals(
    await computeProblemContentHash(a),
    await computeProblemContentHash(b as typeof a),
  );
  // 文件顺序与 role 排序无关
  const files = [
    { role: "oi_file" as const, path: "b.in", sha256: "2" },
    { role: "support_package" as const, path: "package.zip", sha256: "1" },
  ];
  assertEquals(
    await computeProblemContentHash(a, files),
    await computeProblemContentHash(a, [...files].reverse()),
  );
  // 文件哈希变化必须改变内容哈希
  assert(
    (await computeProblemContentHash(a, files)) !==
      (await computeProblemContentHash(a, [
        { role: "support_package" as const, path: "package.zip", sha256: "9" },
        { role: "oi_file" as const, path: "b.in", sha256: "2" },
      ])),
  );
  // 内容变化必须改变内容哈希
  assert(
    (await computeProblemContentHash(a)) !==
      (await computeProblemContentHash(
        aiContent({ title: "改标题" }) as typeof a,
      )),
  );
  // 未知哈希（存量对象）稳定表达为同一种形态
  assertEquals(
    await computeProblemContentHash(a, [
      { role: "oi_file" as const, path: "a.in", sha256: null },
    ]),
    await computeProblemContentHash(a, [
      { role: "oi_file" as const, path: "a.in", sha256: null },
    ]),
  );
});

Deno.test("content: 发布完整性校验拒绝不完整内容", async () => {
  validateProblemContent("ai", aiContent());
  await assertThrows(() =>
    validateProblemContent("ai", {
      kind: "ai",
      title: "x",
      description: "d",
      samples: [],
    })
  );
  await assertThrows(() =>
    validateProblemContent("ai", aiContent({ submission_mode: "invalid" }))
  );
  await assertThrows(() =>
    validateProblemContent("ai", aiContent({ artifact_max_size_mb: 0 }))
  );
  // 客观题：空卷、缺 key、key 重复都拒绝
  await assertThrows(() =>
    validateProblemContent("objective", {
      kind: "objective",
      title: "x",
      description: "d",
      samples: [],
      questions: [],
    })
  );
  await assertThrows(() =>
    validateProblemContent("objective", {
      kind: "objective",
      title: "x",
      description: "d",
      samples: [],
      questions: [{ type: "single", prompt: "p", answer: ["A"] }],
    })
  );
  await assertThrows(() =>
    validateProblemContent("objective", {
      kind: "objective",
      title: "x",
      description: "d",
      samples: [],
      questions: [
        { key: "k", type: "single", prompt: "p", answer: ["A"] },
        { key: "k", type: "single", prompt: "q", answer: ["B"] },
      ],
    })
  );
  // 类别不一致
  await assertThrows(() => validateProblemContent("oi", aiContent()));
  // 合法客观题通过
  validateProblemContent("objective", {
    kind: "objective",
    title: "x",
    description: "d",
    samples: [],
    questions: [
      {
        key: "k",
        sort_order: 0,
        type: "single",
        prompt: "p",
        options: [],
        answer: ["A"],
        explanation: "",
      },
    ],
  });
});

Deno.test("content: 题型与提交模式不可变", async () => {
  const ai = aiContent();
  const oiContent = {
    kind: "oi",
    title: "t",
    description: "d",
    samples: [],
    runtime_config: {
      backend: "native",
      languages: ["c"],
      time_limit_ms: 1000,
      memory_limit_mb: 256,
      checker: { type: "default" },
      subtasks: [],
    },
  };
  // 类别变化 → 拒绝
  await assertThrows(() =>
    assertContentKindTransition("oi", null, ai as never)
  );
  // AI 提交模式变化 → 拒绝
  await assertThrows(() =>
    assertContentKindTransition(
      "ai",
      "code",
      aiContent({ submission_mode: "artifact" }) as never,
    )
  );
  // 相同模式 / 首次发布 / 非 AI 类别 → 通过
  assertContentKindTransition("ai", "code", ai as never);
  assertContentKindTransition("ai", null, ai as never);
  assertContentKindTransition("oi", null, oiContent as never);
});

Deno.test("policy: 默认作答版本与策略自洽", () => {
  assertEquals(
    resolveDefaultAnswerVersion({
      latest_version_id: "v2",
      effective_version_mode: "any",
      required_version_id: null,
    }),
    "v2",
  );
  assertEquals(
    resolveDefaultAnswerVersion({
      latest_version_id: "v2",
      effective_version_mode: "exact",
      required_version_id: "v1",
    }),
    "v1",
  );
  assertEquals(
    resolveDefaultAnswerVersion({
      latest_version_id: null,
      effective_version_mode: "any",
      required_version_id: null,
    }),
    null,
  );
  assertEquals(
    resolveContestAnswerVersion({ pinned_version_id: "pinned" }),
    "pinned",
  );
  assertEquals(resolveContestAnswerVersion({ pinned_version_id: null }), null);

  assert(isPolicyCoherent("any", null));
  assert(!isPolicyCoherent("any", "v1"));
  assert(isPolicyCoherent("exact", "v1"));
  assert(!isPolicyCoherent("exact", null));
  assert(!isPolicyCoherent("weird", null));
});

Deno.test("policy: 列形态与策略对象互转", () => {
  assertEquals(policyToColumns({ mode: "any" }), {
    effective_version_mode: "any",
    required_version_id: null,
  });
  assertEquals(policyToColumns({ mode: "exact", version_id: "v9" }), {
    effective_version_mode: "exact",
    required_version_id: "v9",
  });
  assertEquals(policyFromColumns("any", null), { mode: "any" });
  assertEquals(policyFromColumns(null, null), { mode: "any" });
  assertEquals(policyFromColumns("exact", "v9"), {
    mode: "exact",
    version_id: "v9",
  });
  // 非法形态不抛错，由调用方决定（读取路径必须宽容）
  assertEquals(policyFromColumns("exact", null), null);
  assertEquals(policyFromColumns("weird", null), null);
});
