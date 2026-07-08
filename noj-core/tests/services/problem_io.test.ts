/**
 * 题目导入导出服务测试（issue #28）。
 *
 * 覆盖 buildExportPayload 的核心路径：
 * - 参数互斥校验
 * - 按 ids 导出
 * - 按 type 导出
 * - samples 抽取
 * - 分类注入
 * - 不支持协议前缀拒绝
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  buildExportPayload,
  createProblem,
  getProblem,
  importProblems,
} from "../../src/services/problems.ts";
import { createCategory } from "../../src/services/categories.ts";
import { resetDbForTest } from "../../src/db/connection.ts";
import { BadRequestError } from "../../src/lib/errors.ts";

// 共享测试夹具：模块顶层声明但延迟初始化（PR #116 review 修复）
// - 避免模块顶层副作用污染其他测试文件的文件级隔离
// - 每个测试用例都通过 hasEnv gating（与 noj-core/AGENTS.md「测试约定」一致）
// - 实际初始化在 Deno.test("00 setup") 中按文件名前缀字母序先行执行
const skip = !Deno.env.get("DATABASE_URL");
const ts = Date.now();

interface Fixture {
  catA: { id: string; name: string; slug: string };
  catB: { id: string; name: string; slug: string };
  PROBLEM_WITH_SAMPLES: { id: string; title: string; number: number };
  PROBLEM_PLAIN: { id: string; title: string; number: number };
}
const fixture: { value?: Fixture } = {};

Deno.test({
  name: "00 setup: 初始化 PGlite + 分类 + 测试题目",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const catA = await createCategory({
      name: `基础-${ts}`,
      slug: `basic-${ts}`,
    });
    const catB = await createCategory({
      name: `数组-${ts}`,
      slug: `array-${ts}`,
    });
    const PROBLEM_WITH_SAMPLES = await createProblem(
      {
        title: `含样例的题-${ts}`,
        description:
          `# 题目\n\n题目描述。\n\n## 样例输入\n\n1 2\n\n## 样例输出\n\n3\n\n## 样例输入 #2\n\n4 5\n\n## 样例输出 #2\n\n9\n`,
        difficulty: "easy",
        judge_image: "noj-judge-python",
        judge_command: "python3 /tmp/evaluate.py",
        time_limit_ms: 1000,
        memory_limit_mb: 256,
        type: "P",
        category_ids: [catA.id, catB.id],
      },
      "test-admin",
      "admin",
    );
    const PROBLEM_PLAIN = await createProblem(
      {
        title: `普通题-${ts}`,
        description: "# 普通题\n\n没有样例段。",
        difficulty: "medium",
        judge_image: "noj-judge-python",
        judge_command: "python3 /tmp/evaluate.py",
        time_limit_ms: 2000,
        memory_limit_mb: 512,
        type: "P",
      },
      "test-admin",
      "admin",
    );
    fixture.value = { catA, catB, PROBLEM_WITH_SAMPLES, PROBLEM_PLAIN };
  },
});

/** 取夹具；若 setup 未运行则跳过当前测试。 */
function fx(): Fixture {
  if (!fixture.value) throw new Error("setup 未运行（应已被 ignore 跳过）");
  return fixture.value;
}

Deno.test({
  name: "export: ids 和 type 都未提供 → 拒绝",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () => buildExportPayload({}, "test-admin"),
      BadRequestError,
      "必须提供 ids 或 type 之一",
    );
  },
});

Deno.test({
  name: "export: ids 和 type 同时提供 → 拒绝",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        buildExportPayload(
          { ids: ["x"], type: "P" },
          "test-admin",
        ),
      BadRequestError,
      "互斥",
    );
  },
});

Deno.test({
  name: "export: 非法 type → 拒绝",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () => buildExportPayload({ type: "X" as never }, "test-admin"),
      BadRequestError,
      "非法题目类型",
    );
  },
});

Deno.test({
  name: "export: 按 ids 导出包含元数据 + samples + 分类",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const payload = await buildExportPayload(
      { ids: [fx().PROBLEM_WITH_SAMPLES.id] },
      "test-admin",
    );
    assertEquals(payload.version, "1.0");
    assertEquals(payload.exported_by, "test-admin");
    assertEquals(payload.problems.length, 1);
    const p = payload.problems[0];
    assertEquals(p.id, fx().PROBLEM_WITH_SAMPLES.id);
    assertEquals(p.title, `含样例的题-${ts}`);
    assertEquals(p.difficulty, "easy");
    assertEquals(p.time_limit_ms, 1000);
    assertEquals(p.memory_limit_mb, 256);
    assertEquals(p.type, "P");
    assertEquals(p.judge_images, ["noj-judge-python"]);
    assertEquals(p.judge_command, "python3 /tmp/evaluate.py");
    assertEquals(p.samples.length, 2);
    assertEquals(p.samples[0], { input: "1 2", output: "3" });
    assertEquals(p.samples[1], { input: "4 5", output: "9" });
    assertEquals(p.categories.length, 2);
    const names = p.categories.map((c) => c.name).sort();
    assertEquals(names, [`基础-${ts}`, `数组-${ts}`]);
  },
});

Deno.test({
  name: "export: description 无样例段时 samples 为空数组",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const payload = await buildExportPayload(
      { ids: [fx().PROBLEM_PLAIN.id] },
      "test-admin",
    );
    assertEquals(payload.problems[0].samples, []);
  },
});

Deno.test({
  name: "export: display_id = ${type}${number}",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const payload = await buildExportPayload(
      { type: "P" },
      "test-admin",
    );
    const found = payload.problems.find(
      (p) => p.id === fx().PROBLEM_WITH_SAMPLES.id,
    );
    assertEquals(found?.display_id, `P${fx().PROBLEM_WITH_SAMPLES.number}`);
  },
});

Deno.test({
  name: "export: 按 type=P 批量导出包含所有 P 型题",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const payload = await buildExportPayload({ type: "P" }, "test-admin");
    const ids = payload.problems.map((p) => p.id);
    assertEquals(ids.includes(fx().PROBLEM_WITH_SAMPLES.id), true);
    assertEquals(ids.includes(fx().PROBLEM_PLAIN.id), true);
    for (const p of payload.problems) {
      assertEquals(p.type, "P");
    }
  },
});

Deno.test({
  name: "export: 不存在的 ids 返空 problems 数组（不报错）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const payload = await buildExportPayload(
      { ids: ["non-existent-id"] },
      "test-admin",
    );
    assertEquals(payload.problems, []);
  },
});

// ─── 导入测试 ──────────────────────────────────────────────

Deno.test({
  name: "import: 非 create/overwrite/skip 策略 → 拒绝",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        importProblems(
          { version: "1.0", problems: [] },
          "bogus" as never,
          "test-admin",
          "admin",
        ),
      BadRequestError,
      "非法导入策略",
    );
  },
});

Deno.test({
  name: "import: version 不匹配 → 拒绝",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        importProblems(
          { version: "2.0", problems: [] },
          "create",
          "test-admin",
          "admin",
        ),
      BadRequestError,
      "不支持的导入文件版本",
    );
  },
});

Deno.test({
  name: "import: 缺 problems 字段 → 拒绝",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        importProblems(
          { version: "1.0" }, // 有 version 但缺 problems
          "create",
          "test-admin",
          "admin",
        ),
      BadRequestError,
      "problems 数组",
    );
  },
});

Deno.test({
  name: "import: 单题全字段 round-trip（overwrite 策略）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 先 export 一道
    const exported = await buildExportPayload(
      { ids: [fx().PROBLEM_WITH_SAMPLES.id] },
      "test-admin",
    );
    // 然后 import 同一份（不同 id 时新建；同 id 时按 strategy 走）
    // 这里 source id 已存在 → overwrite 应该更新成功
    const report = await importProblems(
      exported,
      "overwrite",
      "test-admin",
      "admin",
    );
    assertEquals(report.total, 1);
    assertEquals(report.created.length, 0);
    assertEquals(report.updated.length, 1);
    assertEquals(report.updated[0].id, fx().PROBLEM_WITH_SAMPLES.id);
    assertEquals(report.failed.length, 0);

    // 验证 DB 状态保持
    const reloaded = await getProblem(fx().PROBLEM_WITH_SAMPLES.id);
    assertEquals(reloaded.title, `含样例的题-${ts}`);
    // samples 不在 ProblemResponse（只存在 description 文本内）
    assertEquals(
      (reloaded as unknown as { samples?: unknown }).samples,
      undefined,
    );
    assertEquals(reloaded.description.includes("样例输入"), true);
  },
});

Deno.test({
  name: "import: 不存在的源 id + create 策略 → 新建",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const newId = crypto.randomUUID();
    const payload = {
      version: "1.0" as const,
      exported_at: new Date().toISOString(),
      exported_by: "test-admin",
      problems: [
        {
          id: newId,
          display_id: "P9001",
          type: "P" as const,
          number: 9001,
          title: "全新导入题",
          description: "# 全新\n\n## 样例输入\n\na\n\n## 样例输出\n\nb\n",
          difficulty: "hard",
          categories: [{ name: `基础-${ts}`, slug: `basic-${ts}` }],
          judge_images: ["noj-judge-python"],
          judge_command: "python3 /tmp/evaluate.py",
          time_limit_ms: 3000,
          memory_limit_mb: 128,
          support_package_storage_url: null,
          test_cases_ref: null,
          samples: [{ input: "a", output: "b" }],
        },
      ],
    };
    const report = await importProblems(
      payload,
      "create",
      "test-admin",
      "admin",
    );
    assertEquals(report.created.length, 1);
    assertEquals(report.created[0].id, newId);
    // 实际写入的 id 应该不同于 source id（避免跨 DB 冲突）
    assertEquals(report.created[0].problem_id !== newId, true);

    // 验证题已存在
    const created = await getProblem(report.created[0].problem_id!);
    assertEquals(created.title, "全新导入题");
    assertEquals(created.number, 9001);
  },
});

Deno.test({
  name: "import: skip 策略下已存在 → 跳过",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const exported = await buildExportPayload(
      { ids: [fx().PROBLEM_PLAIN.id] },
      "test-admin",
    );
    const report = await importProblems(
      exported,
      "skip",
      "test-admin",
      "admin",
    );
    assertEquals(report.skipped.length, 1);
    assertEquals(report.skipped[0].id, fx().PROBLEM_PLAIN.id);
    assertEquals(report.created.length, 0);
    assertEquals(report.updated.length, 0);
  },
});

Deno.test({
  name: "import: create 策略下已存在 → 跳过（不报错）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const exported = await buildExportPayload(
      { ids: [fx().PROBLEM_PLAIN.id] },
      "test-admin",
    );
    const report = await importProblems(
      exported,
      "create",
      "test-admin",
      "admin",
    );
    assertEquals(report.skipped.length, 1);
    assertEquals(report.created.length, 0);
  },
});

Deno.test({
  name: "import: 分类名在当前 DB 找不到 → 忽略该分类（不报错）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const newId = crypto.randomUUID();
    const payload = {
      version: "1.0" as const,
      exported_at: new Date().toISOString(),
      exported_by: "test-admin",
      problems: [
        {
          id: newId,
          display_id: "P9002",
          type: "P" as const,
          number: 9002,
          title: "部分分类缺失题",
          description: "无样例",
          difficulty: "easy",
          categories: [
            { name: `基础-${ts}`, slug: `basic-${ts}` }, // 存在
            { name: "完全不存在的分类", slug: "no-such-cat" }, // 不存在
          ],
          judge_images: ["noj-judge-python"],
          judge_command: "python3 /tmp/evaluate.py",
          time_limit_ms: 1000,
          memory_limit_mb: 256,
          support_package_storage_url: null,
          test_cases_ref: null,
          samples: [],
        },
      ],
    };
    const report = await importProblems(
      payload,
      "create",
      "test-admin",
      "admin",
    );
    assertEquals(report.created.length, 1);
    // 警告应在 reason 里
    const r = report.created[0];
    assertEquals(r.reason?.includes("完全不存在的分类"), true);

    // 验证：基础分类已关联，不存在的未关联
    const created = await getProblem(r.problem_id!);
    const catNames = created.categories.map((c) => c.name);
    assertEquals(catNames.includes(`基础-${ts}`), true);
    assertEquals(catNames.includes("完全不存在的分类"), false);
  },
});

Deno.test({
  name: "import: 非法难度值 → 单条失败，其他成功",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const goodId = crypto.randomUUID();
    const badId = crypto.randomUUID();
    const payload = {
      version: "1.0" as const,
      exported_at: new Date().toISOString(),
      exported_by: "test-admin",
      problems: [
        {
          id: goodId,
          display_id: "P9003",
          type: "P" as const,
          number: 9003,
          title: "好的题",
          description: "",
          difficulty: "easy",
          categories: [],
          judge_images: ["noj-judge-python"],
          judge_command: "python3 /tmp/evaluate.py",
          time_limit_ms: 1000,
          memory_limit_mb: 256,
          support_package_storage_url: null,
          test_cases_ref: null,
          samples: [],
        },
        {
          id: badId,
          display_id: "P9004",
          type: "P" as const,
          number: 9004,
          title: "坏的题",
          description: "",
          difficulty: "impossible" as never,
          categories: [],
          judge_images: ["noj-judge-python"],
          judge_command: "python3 /tmp/evaluate.py",
          time_limit_ms: 1000,
          memory_limit_mb: 256,
          support_package_storage_url: null,
          test_cases_ref: null,
          samples: [],
        },
      ],
    };
    const report = await importProblems(
      payload,
      "create",
      "test-admin",
      "admin",
    );
    assertEquals(report.created.length, 1);
    assertEquals(report.failed.length, 1);
    assertEquals(report.failed[0].id, badId);
    assertEquals(report.failed[0].reason?.includes("难度"), true);
  },
});

Deno.test({
  name: "import: 不支持的协议前缀 → 单条失败",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const newId = crypto.randomUUID();
    const payload = {
      version: "1.0" as const,
      exported_at: new Date().toISOString(),
      exported_by: "test-admin",
      problems: [
        {
          id: newId,
          display_id: "P9005",
          type: "P" as const,
          number: 9005,
          title: "坏 URL 题",
          description: "",
          difficulty: "easy",
          categories: [],
          judge_images: ["noj-judge-python"],
          judge_command: "python3 /tmp/evaluate.py",
          time_limit_ms: 1000,
          memory_limit_mb: 256,
          support_package_storage_url: "https://evil.example.com/x.zip",
          test_cases_ref: null,
          samples: [],
        },
      ],
    };
    const report = await importProblems(
      payload,
      "create",
      "test-admin",
      "admin",
    );
    assertEquals(report.failed.length, 1);
    assertEquals(report.failed[0].reason?.includes("协议"), true);
  },
});
