# 客观题套卷加入统一题目包 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让统一题目包（Problem Bundle）支持客观题套卷，使其能像编程题一样通过 zip 构建、导入、幂等更新。

**Architecture:** 在现有 `problem.json` manifest 上增加可选 `is_objective` 字段，客观题包用独立 `questions.json` 承载小题；解析器/校验器/导入服务按 `is_objective` 分支，客观题不要求 `evaluate.py`/`runtime_config`，不产生评测包存储，并在同一 DB 事务内创建/更新套卷 + 全量替换小题。

**Tech Stack:** Deno 2、Hono、Drizzle ORM、fflate、PGlite（测试）、Cliffy（CLI）。

**Spec:** `docs/superpowers/specs/2026-09-01-objective-bundle-design.md`

## Global Constraints

- 保持 `format_version=1`，不升级 v2。
- 客观题包必须包含根级 `questions.json`，且至少 1 道小题。
- 客观题包不要求 `evaluate.py` / `runtime_config`；若提供 `runtime_config` / `llm` / `template` / `submission_mode` / `artifact_max_size_mb` 则返回 HTTP 400。
- 客观题导入支持幂等更新：admin 提供 `number` 时按 `(type, number)` 匹配，命中则更新元数据并全量替换小题；未命中则创建。非 admin 提供 `number` 返回 400。
- 客观题导入不自动重测：历史 `objective_submissions` 保持原判定结果。
- 客观题禁止关联算法标签（沿用现有 `validateProblemTagIds` / `syncProblemTags` 规则）。
- 所有 Deno 测试通过 `deno task test` / `test:parallel` 运行；代码需通过 `deno fmt` / `deno lint`。
- 提交信息使用中文 Conventional Commits，例如 `feat(core): 统一题目包支持客观题套卷`。

---

### Task 1: manifest 支持 `is_objective` 与 `questions.json` 校验

**Files:**
- Modify: `noj-core/src/types/problem-bundle.ts`
- Test: `noj-core/tests/services/problem-bundle.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `validateBundleManifest`、`ProblemBundleManifest`、`BUNDLE_FORMAT_VERSION`。
- Produces:
  - `ProblemBundleManifest` 增加可选字段 `is_objective?: boolean`，`runtime_config` 改为可选 `runtime_config?: RuntimeConfig`。
  - `validateBundleManifest(raw: unknown): ProblemBundleManifest` 支持客观题分支。
  - `validateObjectiveQuestions(raw: unknown): CreateQuestionInput[]`（从 `types/objective.ts` 复用 `CreateQuestionInput`、`validateAnswerForType`、`validateOptions`、`isValidQuestionType`）。

- [ ] **Step 1: 写失败测试**

创建 `noj-core/tests/services/problem-bundle.test.ts`：

```ts
/**
 * problem-bundle 类型/校验单元测试。
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { BadRequestError } from "../../src/lib/errors.ts";
import {
  validateBundleManifest,
  validateObjectiveQuestions,
} from "../../src/types/problem-bundle.ts";

Deno.test("validateBundleManifest: 客观题 manifest 不要求 runtime_config", () => {
  const manifest = validateBundleManifest({
    format_version: 1,
    title: "客观题套卷",
    is_objective: true,
    type: "U",
  });
  assertEquals(manifest.is_objective, true);
  assertEquals(manifest.runtime_config, undefined);
});

Deno.test("validateBundleManifest: 客观题 manifest 携带 runtime_config 被拒", () => {
  assertThrows(
    () =>
      validateBundleManifest({
        format_version: 1,
        title: "客观题套卷",
        is_objective: true,
        runtime_config: {
          evaluator: { image: "x" },
          solution: { image: "y" },
        },
      }),
    BadRequestError,
    /runtime_config/,
  );
});

Deno.test("validateBundleManifest: 客观题 manifest 携带 llm/template/submission_mode/artifact_max_size_mb 被拒", () => {
  for (const extra of [
    { llm: { provider_id: "p", model: "m" } },
    { template: "template.py" },
    { submission_mode: "artifact" },
    { artifact_max_size_mb: 10 },
  ]) {
    assertThrows(
      () =>
        validateBundleManifest({
          format_version: 1,
          title: "客观题套卷",
          is_objective: true,
          ...extra,
        }),
      BadRequestError,
    );
  }
});

Deno.test("validateBundleManifest: 非客观题仍要求 runtime_config", () => {
  assertThrows(
    () =>
      validateBundleManifest({
        format_version: 1,
        title: "编程题",
      }),
    BadRequestError,
    /runtime_config/,
  );
});

Deno.test("validateObjectiveQuestions: 合法小题数组通过", () => {
  const questions = validateObjectiveQuestions([
    {
      type: "single",
      prompt: "1+1=?",
      options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
      answer: ["A"],
      explanation: "因为 1+1=2",
    },
    {
      type: "judge",
      prompt: "地球是圆的",
      answer: [true],
    },
  ]);
  assertEquals(questions.length, 2);
  assertEquals(questions[0].sort_order, 0);
  assertEquals(questions[1].sort_order, 1);
});

Deno.test("validateObjectiveQuestions: 空数组被拒", () => {
  assertThrows(() => validateObjectiveQuestions([]), BadRequestError, /非空数组/);
});

Deno.test("validateObjectiveQuestions: 非法题型/答案/选项/重复 sort_order 被拒", () => {
  assertThrows(
    () =>
      validateObjectiveQuestions([
        {
          type: "single",
          prompt: "x",
          options: [{ key: "A", text: "a" }],
          answer: ["A", "B"],
        },
      ]),
    BadRequestError,
    /answer/,
  );
  assertThrows(
    () =>
      validateObjectiveQuestions([
        {
          type: "single",
          prompt: "x",
          options: [{ key: "A", text: "a" }],
          answer: ["B"],
        },
      ]),
    BadRequestError,
    /不存在/,
  );
  assertThrows(
    () =>
      validateObjectiveQuestions([
        {
          type: "single",
          prompt: "x",
          options: [{ key: "A", text: "a" }],
          answer: ["A"],
        },
        {
          type: "single",
          prompt: "y",
          options: [{ key: "A", text: "a" }],
          answer: ["A"],
          sort_order: 0,
        },
      ]),
    BadRequestError,
    /sort_order/,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && BCRYPT_SALT_ROUNDS=4 env -u DATABASE_URL deno test -A --no-check --preload=tests/preload.ts tests/services/problem-bundle.test.ts`
Expected: FAIL，`validateObjectiveQuestions` / `is_objective` 不存在。

- [ ] **Step 3: 修改 `types/problem-bundle.ts`**

在文件顶部 import 增加：

```ts
import {
  type CreateQuestionInput,
  type ObjectiveAnswerValue,
  type ObjectiveOption,
  isValidQuestionType,
  validateAnswerForType,
  validateOptions,
} from "./objective.ts";
```

将 `ProblemBundleManifest` 改为：

```ts
export interface ProblemBundleManifest {
  format_version: number;
  title: string;
  description?: string;
  difficulty?: string;
  type?: string;
  number?: number;
  tags?: string[];
  samples?: ProblemBundleSample[];
  template?: string;
  submission_mode?: string;
  artifact_max_size_mb?: number | null;
  llm?: LlmConfig;
  /** 客观题套卷标记：true 时使用 questions.json，不要求 runtime_config/evaluate.py */
  is_objective?: boolean;
  /** 编程题必填；客观题缺省 */
  runtime_config?: RuntimeConfig;
}
```

在 `validateBundleManifest` 开头（`const m = raw as Record<string, unknown>;` 之后）增加：

```ts
  if (
    m.is_objective !== undefined && typeof m.is_objective !== "boolean"
  ) {
    throw new BadRequestError("manifest.is_objective 必须是布尔值");
  }
  const isObjective = m.is_objective === true;
```

将 `validateBundleManifest` 中 `runtime_config` 校验段替换为：

```ts
  if (isObjective) {
    if (m.runtime_config !== undefined) {
      throw new BadRequestError("客观题套卷不允许提供 runtime_config");
    }
    if (m.llm !== undefined) {
      throw new BadRequestError("客观题套卷不允许提供 llm");
    }
    if (m.template !== undefined) {
      throw new BadRequestError("客观题套卷不允许提供 template");
    }
    if (m.submission_mode !== undefined) {
      throw new BadRequestError("客观题套卷不允许提供 submission_mode");
    }
    if (m.artifact_max_size_mb !== undefined) {
      throw new BadRequestError("客观题套卷不允许提供 artifact_max_size_mb");
    }
  } else {
    if (typeof m.runtime_config !== "object" || m.runtime_config === null) {
      throw new BadRequestError("manifest.runtime_config 是必填字段");
    }
    // 注入 command 默认值后执行既有结构校验（含镜像白名单由调用方在落库前校验）
    const runtimeConfig = resolveManifestCommand(
      m.runtime_config as RuntimeConfig,
    );
    validateRuntimeConfig(runtimeConfig);

    if (llm !== undefined && !runtimeConfig.evaluator.network?.enabled) {
      throw new BadRequestError("启用 LLM 必须开启 evaluator 网络");
    }
  }
```

注意：原代码中 `llm` 变量在 `runtime_config` 校验之前已经计算；保留该计算，但把 `llm` 与 `runtime_config` 的联动校验移入 `else` 分支。同时删除原来位于 `runtime_config` 校验之后的 `if (llm !== undefined && !runtimeConfig.evaluator.network?.enabled)` 重复块。

将 `validateBundleManifest` 的 return 改为：

```ts
  return {
    format_version: m.format_version as number,
    title: m.title as string,
    description: m.description as string | undefined,
    difficulty: m.difficulty as string | undefined,
    type: m.type as string | undefined,
    number: m.number as number | undefined,
    tags: m.tags as string[] | undefined,
    samples: m.samples as ProblemBundleSample[] | undefined,
    template: m.template as string | undefined,
    submission_mode: m.submission_mode as string | undefined,
    artifact_max_size_mb: m.artifact_max_size_mb as number | null | undefined,
    llm,
    is_objective: isObjective,
    runtime_config: isObjective ? undefined : (m.runtime_config as RuntimeConfig),
  };
```

在文件末尾新增：

```ts
/**
 * 校验客观题小题数组（questions.json）。
 *
 * 每项对应 CreateQuestionInput；sort_order 缺省按数组下标；至少 1 道。
 *
 * @throws {BadRequestError} 任一小题非法
 */
export function validateObjectiveQuestions(
  raw: unknown,
): CreateQuestionInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BadRequestError("questions.json 必须是非空数组");
  }
  const seenSort = new Set<number>();
  return raw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new BadRequestError(`questions.json[${index}] 必须是对象`);
    }
    const q = item as Record<string, unknown>;
    const type = q.type;
    if (typeof type !== "string" || !isValidQuestionType(type)) {
      throw new BadRequestError(
        `questions.json[${index}].type 非法，仅允许 single/multiple/judge`,
      );
    }
    if (typeof q.prompt !== "string" || !q.prompt.trim()) {
      throw new BadRequestError(
        `questions.json[${index}].prompt 必须是非空字符串`,
      );
    }

    let options: ObjectiveOption[] | undefined;
    if (type === "judge") {
      options = undefined;
    } else {
      if (q.options === undefined) {
        throw new BadRequestError(`questions.json[${index}].options 必填`);
      }
      try {
        validateOptions(q.options);
      } catch (err) {
        throw new BadRequestError(
          `questions.json[${index}].options 非法：${(err as Error).message}`,
        );
      }
      options = q.options as ObjectiveOption[];
    }

    let answer: ObjectiveAnswerValue[];
    try {
      validateAnswerForType(type, q.answer);
    } catch (err) {
      throw new BadRequestError(
        `questions.json[${index}].answer 非法：${(err as Error).message}`,
      );
    }
    answer = q.answer as ObjectiveAnswerValue[];

    if (type !== "judge" && options) {
      for (const key of answer as string[]) {
        if (!options.some((o) => o.key === key)) {
          throw new BadRequestError(
            `questions.json[${index}].answer 选项 ${key} 不存在于选项中`,
          );
        }
      }
    }

    let sortOrder = q.sort_order;
    if (sortOrder === undefined) {
      sortOrder = index;
    } else if (
      typeof sortOrder !== "number" || !Number.isInteger(sortOrder) ||
      sortOrder < 0
    ) {
      throw new BadRequestError(
        `questions.json[${index}].sort_order 必须是非负整数`,
      );
    }
    if (seenSort.has(sortOrder)) {
      throw new BadRequestError(
        `questions.json 中 sort_order ${sortOrder} 重复`,
      );
    }
    seenSort.add(sortOrder);

    return {
      type,
      prompt: q.prompt,
      options: type === "judge" ? undefined : options,
      answer,
      explanation: typeof q.explanation === "string" ? q.explanation : undefined,
      sort_order: sortOrder,
    };
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && BCRYPT_SALT_ROUNDS=4 env -u DATABASE_URL deno test -A --no-check --preload=tests/preload.ts tests/services/problem-bundle.test.ts`
Expected: PASS

- [ ] **Step 5: 运行 fmt/lint**

Run: `deno fmt noj-core/src/types/problem-bundle.ts noj-core/tests/services/problem-bundle.test.ts && deno lint noj-core/src/types/problem-bundle.ts noj-core/tests/services/problem-bundle.test.ts`
Expected: 无输出/无错误

- [ ] **Step 6: Commit**

```bash
jj describe -m "feat(core): 统一题目包 manifest 支持客观题 is_objective 与 questions.json 校验"
```

---

### Task 2: 解析器支持客观题包

**Files:**
- Modify: `noj-core/src/lib/bundle-parser.ts`
- Test: `noj-core/tests/lib/bundle-parser.test.ts`

**Interfaces:**
- Consumes: `ParsedProblemBundle`（现有）、`BadRequestError`。
- Produces:
  - `ParsedProblemBundle` 增加 `questions: unknown | null`。
  - `parseBundleZip(data: Uint8Array): ParsedProblemBundle` 在 `is_objective=true` 时不要求 `evaluate.py`，改为要求 `questions.json` 并解析其 JSON。

- [ ] **Step 1: 写失败测试**

在 `noj-core/tests/lib/bundle-parser.test.ts` 末尾追加：

```ts
const OBJECTIVE_MANIFEST = JSON.stringify({
  format_version: 1,
  title: "客观题套卷",
  is_objective: true,
  type: "U",
});

function objectiveBundle(): Uint8Array {
  return makeZip({
    "problem.json": OBJECTIVE_MANIFEST,
    "questions.json": JSON.stringify([
      {
        type: "single",
        prompt: "1+1=?",
        options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
        answer: ["A"],
      },
    ]),
    "statement.md": "# 客观题套卷",
  });
}

Deno.test("parseBundleZip: 客观题包不要求 evaluate.py 且解析 questions.json", () => {
  const parsed = parseBundleZip(objectiveBundle());
  assertEquals(parsed.manifest.is_objective, true);
  assertEquals(Array.isArray(parsed.questions), true);
  assertEquals((parsed.questions as Array<{ prompt: string }>)[0].prompt, "1+1=?");
});

Deno.test("parseBundleZip: 客观题包缺 questions.json 被拒", () => {
  const zip = makeZip({
    "problem.json": OBJECTIVE_MANIFEST,
    "statement.md": "# 客观题套卷",
  });
  const err = assertThrows(() => parseBundleZip(zip), BadRequestError);
  assertMatch(err.message, /questions\.json/);
});

Deno.test("parseBundleZip: 客观题包 questions.json 非法 JSON 被拒", () => {
  const zip = makeZip({
    "problem.json": OBJECTIVE_MANIFEST,
    "questions.json": "not-json{{{",
  });
  const err = assertThrows(() => parseBundleZip(zip), BadRequestError);
  assertMatch(err.message, /questions\.json/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && BCRYPT_SALT_ROUNDS=4 env -u DATABASE_URL deno test -A --no-check --preload=tests/preload.ts tests/lib/bundle-parser.test.ts`
Expected: FAIL，`parsed.questions` 不存在 / 客观题包仍要求 evaluate.py。

- [ ] **Step 3: 修改 `lib/bundle-parser.ts`**

在 `ParsedProblemBundle` 接口增加：

```ts
  /** `questions.json` 内容（客观题包；不存在为 null） */
  questions: unknown | null;
```

在 `parseBundleZip` 中，将 `if (!rootNames.has("evaluate.py"))` 块替换为：

```ts
  const manifestFile = files["problem.json"];
  const statementFile = files["statement.md"];

  let manifest: Record<string, unknown>;
  try {
    const text = new TextDecoder().decode(manifestFile);
    const parsed = JSON.parse(text);
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      throw new Error("not-object");
    }
    manifest = parsed as Record<string, unknown>;
  } catch {
    throw new BadRequestError("problem.json 不是合法的 JSON 对象");
  }

  const isObjective = manifest.is_objective === true;
  if (isObjective) {
    if (!rootNames.has("questions.json")) {
      throw new BadRequestError(
        "客观题套卷包必须包含 questions.json（小题数组）",
      );
    }
  } else if (!rootNames.has("evaluate.py")) {
    throw new BadRequestError(
      "zip 根级缺少 evaluate.py（评测脚本必须位于包根级）",
    );
  }

  const questionsFile = files["questions.json"];
  let questions: unknown = null;
  if (questionsFile) {
    try {
      questions = JSON.parse(new TextDecoder().decode(questionsFile));
    } catch {
      throw new BadRequestError("questions.json 不是合法的 JSON");
    }
  }

  return {
    manifest,
    statement: statementFile ? new TextDecoder().decode(statementFile) : null,
    questions,
    entries: files,
  };
```

注意：原代码中 `manifestFile` / `statementFile` 声明在 `evaluate.py` 检查之后；按上述替换后保持顺序正确（先解析 manifest，再按 `is_objective` 检查文件存在性）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && BCRYPT_SALT_ROUNDS=4 env -u DATABASE_URL deno test -A --no-check --preload=tests/preload.ts tests/lib/bundle-parser.test.ts`
Expected: PASS

- [ ] **Step 5: 运行 fmt/lint**

Run: `deno fmt noj-core/src/lib/bundle-parser.ts noj-core/tests/lib/bundle-parser.test.ts && deno lint noj-core/src/lib/bundle-parser.ts noj-core/tests/lib/bundle-parser.test.ts`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
jj describe -m "feat(core): 统一题目包解析器支持客观题包（不要求 evaluate.py，解析 questions.json）"
```

---

### Task 3: 导入服务支持客观题套卷

**Files:**
- Modify: `noj-core/src/services/problems/problem-bundle.ts`
- Test: `noj-core/tests/routes/problem-bundle.test.ts`

**Interfaces:**
- Consumes:
  - `validateObjectiveQuestions`、`ProblemBundleManifest`（Task 1）
  - `parsed.questions`（Task 2）
  - `objectiveQuestions` schema、`judgeOptions`、`validateProblemTagIds`、`CreateQuestionInput`
- Produces:
  - `importProblemBundle` 在 `manifest.is_objective=true` 时走 `importObjectivePaper`。
  - `importObjectivePaper(manifest, description, questions, number, actor, c): Promise<ProblemResponseWithTags>`（模块内私有函数）。

- [ ] **Step 1: 写失败测试**

在 `noj-core/tests/routes/problem-bundle.test.ts` 中新增 helper 和用例。在 `makeZipBlob` 之后新增：

```ts
function makeObjectiveZipBlob(
  manifestOverrides: Record<string, unknown> = {},
  questions: unknown = [
    {
      type: "single",
      prompt: "1+1=?",
      options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
      answer: ["A"],
      explanation: "因为 1+1=2",
    },
  ],
): Blob {
  const manifest = {
    format_version: 1,
    title: `客观题导入测试 ${ts}`,
    difficulty: "easy",
    type: "U",
    is_objective: true,
    ...manifestOverrides,
  };
  const enc = new TextEncoder();
  const zip = zipSync({
    "problem.json": enc.encode(JSON.stringify(manifest)),
    "questions.json": enc.encode(JSON.stringify(questions)),
    "statement.md": enc.encode(`# ${manifest.title}\n`),
  }, { level: 6 });
  return new Blob(
    [zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer],
    { type: "application/zip" },
  );
}
```

在 cleanup 测试之前新增用例：

```ts
Deno.test({
  name: "import-bundle: admin 导入客观题套卷成功（无 evaluate.py/runtime_config，不产生评测包）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await createUserToken("admin");

    const formData = new FormData();
    formData.append("file", makeObjectiveZipBlob(), "obj1.zip");

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.is_objective, true);
    assertEquals(body.data.support_package_storage_url, null);

    const db = getDb();
    const [row] = await db.select().from(problems).where(
      eq(problems.id, body.data.id),
    ).limit(1);
    assertEquals(row.is_objective, true);
    assertEquals(row.runtime_config, null);
    assertEquals(row.support_package_storage_url, null);

    const { objectiveQuestions } = await import("../../src/db/schema.ts");
    const qs = await db.select().from(objectiveQuestions).where(
      eq(objectiveQuestions.paper_id, body.data.id),
    );
    assertEquals(qs.length, 1);
    assertEquals(qs[0].prompt, "1+1=?");
  },
});

Deno.test({
  name: "import-bundle: admin 按 (type, number) 幂等更新客观题套卷并全量替换小题",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await createUserToken("admin");
    const fixedNumber = 73000 + (ts & 0x7fff);

    const formData = new FormData();
    formData.append(
      "file",
      makeObjectiveZipBlob({ number: fixedNumber, title: "旧客观题" }),
      "obj-update1.zip",
    );
    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    const id = body.data.id;

    // 第二次导入：改标题 + 换小题
    const formData2 = new FormData();
    formData2.append(
      "file",
      makeObjectiveZipBlob(
        { number: fixedNumber, title: "新客观题" },
        [
          {
            type: "judge",
            prompt: "地球是圆的",
            answer: [true],
          },
        ],
      ),
      "obj-update2.zip",
    );
    const res2 = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData2,
    });
    assertEquals(res2.status, 200);
    const body2 = await res2.json();
    assertEquals(body2.data.id, id);
    assertEquals(body2.data.title, "新客观题");

    const db = getDb();
    const { objectiveQuestions } = await import("../../src/db/schema.ts");
    const qs = await db.select().from(objectiveQuestions).where(
      eq(objectiveQuestions.paper_id, id),
    );
    assertEquals(qs.length, 1);
    assertEquals(qs[0].type, "judge");
  },
});

Deno.test({
  name: "import-bundle: 客观题包缺 questions.json / 空数组 / 非法字段被拒（400）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await createUserToken("admin");

    // 缺 questions.json
    const enc = new TextEncoder();
    const noQuestionsZip = zipSync({
      "problem.json": enc.encode(JSON.stringify({
        format_version: 1,
        title: "缺小题",
        is_objective: true,
      })),
      "statement.md": enc.encode("# 缺小题"),
    });
    let formData = new FormData();
    formData.append(
      "file",
      new Blob([noQuestionsZip], { type: "application/zip" }),
      "obj-missing.zip",
    );
    let res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 400);

    // 空数组
    formData = new FormData();
    formData.append("file", makeObjectiveZipBlob({}, []), "obj-empty.zip");
    res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 400);

    // 携带 runtime_config
    formData = new FormData();
    formData.append(
      "file",
      makeObjectiveZipBlob({
        runtime_config: {
          evaluator: { image: "x" },
          solution: { image: "y" },
        },
      }),
      "obj-rc.zip",
    );
    res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "import-bundle: 普通用户可创建 U 型客观题套卷，但提供 number 被拒（400）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureUser(OWNER_ID);
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    // 无 number：成功
    const formData = new FormData();
    formData.append("file", makeObjectiveZipBlob(), "obj-user1.zip");
    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 200);

    // 带 number：400
    const formData2 = new FormData();
    formData2.append(
      "file",
      makeObjectiveZipBlob({ number: 12345 }),
      "obj-user2.zip",
    );
    const res2 = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData2,
    });
    assertEquals(res2.status, 400);
  },
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && BCRYPT_SALT_ROUNDS=4 env -u DATABASE_URL deno test -A --no-check --preload=tests/preload.ts tests/routes/problem-bundle.test.ts`
Expected: FAIL，客观题导入仍走编程题路径（缺 evaluate.py 报 400 或 `is_objective` 未落库）。

- [ ] **Step 3: 修改 `services/problems/problem-bundle.ts`**

在 import 区修改/增加：

```ts
// 新增
import { objectiveQuestions } from "../../db/schema.ts";
import { judgeOptions } from "../objective/objective-questions.ts";
import { type CreateQuestionInput } from "../../types/objective.ts";

// 修改现有：problems-tags.ts 的 import 增加 validateProblemTagIds
import { validateProblemTagIds, syncProblemTags } from "./problems-tags.ts";

// 修改现有：types/problem-bundle.ts 的 import 增加 validateObjectiveQuestions
import {
  isValidProblemBundleName,
  type ProblemBundleManifest,
  validateBundleManifest,
  validateObjectiveQuestions,
} from "../../types/problem-bundle.ts";
```

在 `importProblemBundle` 中，将第 4 步（number 权限）之后、第 5 步（剥离元数据）之前插入分支：

```ts
  // 4.5 客观题套卷：走独立导入路径（无评测包，事务性创建/更新 + 全量替换小题）
  if (manifest.is_objective) {
    const questions = validateObjectiveQuestions(parsed.questions);
    return importObjectivePaper(
      manifest,
      description,
      questions,
      number,
      actor,
      c,
    );
  }
```

在 `createViaCrud` 之前新增 `importObjectivePaper` 函数：

```ts
/**
 * 客观题套卷导入路径。
 *
 * 与编程题导入的差异：
 * - 不剥离/上传评测包，support_package_storage_url 保持 NULL；
 * - 套卷行 + 小题全量替换在同一 DB 事务内完成；
 * - 不自动重测历史提交。
 */
async function importObjectivePaper(
  manifest: ProblemBundleManifest,
  description: string,
  questions: CreateQuestionInput[],
  number: number | undefined,
  actor: BundleImportActor,
  c?: Context,
): Promise<ProblemResponseWithTags> {
  const type = manifest.type ?? "U";

  // number 权限（与编程题一致，防御性重复校验）
  if (!(await isAdminActor(actor, c)) && number !== undefined) {
    throw new BadRequestError(
      "仅管理员可指定 number（按 (type, number) 幂等更新既有题目）；普通用户导入时题号由系统自动分配",
    );
  }

  // 类型权限（与 createViaCrud 一致）
  if (type === "P") {
    if (!(await isAdminActor(actor, c))) {
      throw new ForbiddenError("仅管理员可创建管理题");
    }
  } else if (c) {
    const canCreate = await checkPermission(c, "problem:create");
    if (!canCreate) {
      throw new ForbiddenError("无权创建题目");
    }
  } else if (actor.userRole !== "admin" && actor.userRole !== "user") {
    throw new ForbiddenError("无权创建题目");
  }

  const db = getDb();
  const tagIds = await resolveTagIds(manifest.tags);
  // 半写入防护：客观题禁止算法标签在写库前校验
  if (tagIds.length > 0) {
    await validateProblemTagIds(tagIds, true);
  }

  const now = new Date().toISOString();
  let oldStorageUrl: string | null = null;

  const outcome = await db.transaction(async (tx) => {
    let existingId: string | null = null;
    if (number !== undefined) {
      const rows = await tx
        .select({
          id: problems.id,
          storageUrl: problems.support_package_storage_url,
        })
        .from(problems)
        .where(and(eq(problems.type, type), eq(problems.number, number)))
        .limit(1);
      if (rows.length > 0) {
        existingId = rows[0].id;
        oldStorageUrl = rows[0].storageUrl;
      }
    }

    let problemId: string;
    if (existingId) {
      problemId = existingId;
      await tx.update(problems).set({
        title: manifest.title,
        description,
        difficulty: manifest.difficulty ?? "medium",
        is_objective: true,
        runtime_config: null,
        support_package_storage_url: null,
        submission_mode: "code",
        artifact_max_size_mb: null,
        llm_config: null,
        updated_at: now,
      }).where(eq(problems.id, problemId));
    } else {
      problemId = crypto.randomUUID();
      let finalNumber = number;
      const MAX_RETRIES = 3;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (finalNumber === undefined) {
          const [row] = await tx
            .select({ max: sql<number>`COALESCE(MAX(${problems.number}), 0)` })
            .from(problems)
            .where(eq(problems.type, type));
          finalNumber = Number(row?.max ?? 0) + 1;
        }
        try {
          await tx.insert(problems).values({
            id: problemId,
            title: manifest.title,
            description,
            difficulty: manifest.difficulty ?? "medium",
            runtime_config: null,
            is_objective: true,
            number: finalNumber,
            owner_id: actor.userId ?? ROOT_USER_ID,
            type,
            created_at: now,
            updated_at: now,
          });
          break;
        } catch (err) {
          if (attempt === MAX_RETRIES - 1) throw err;
          const pgCode = err && typeof err === "object"
            ? (err as Record<string, unknown>).code ||
              ((err as Record<string, unknown>).cause as Record<string, unknown>)
                ?.code
            : undefined;
          if (pgCode === "23505") {
            if (number !== undefined) throw err;
            finalNumber = undefined;
            continue;
          }
          throw err;
        }
      }
    }

    // 全量替换小题
    await tx.delete(objectiveQuestions).where(
      eq(objectiveQuestions.paper_id, problemId),
    );
    for (const q of questions) {
      const options = q.type === "judge" ? judgeOptions() : (q.options ?? []);
      await tx.insert(objectiveQuestions).values({
        id: crypto.randomUUID(),
        paper_id: problemId,
        sort_order: q.sort_order ?? 0,
        type: q.type,
        prompt: q.prompt,
        options,
        answer: q.answer,
        explanation: q.explanation ?? "",
        created_at: now,
        updated_at: now,
      });
    }

    return { problemId };
  });

  // 标签同步（独立事务，与既有导入一致）
  if (tagIds.length > 0) {
    await syncProblemTags(outcome.problemId, tagIds, true);
  }

  // 若从编程题转换为客观题，尽力清理旧评测包（失败不阻塞）
  if (oldStorageUrl) {
    try {
      const storage = await getStorageProvider();
      await storage.delete(oldStorageUrl);
    } catch (err) {
      logger.warn("客观题导入：删除旧评测包失败", {
        problem_id: outcome.problemId,
        err,
      });
    }
  }

  return getProblem(outcome.problemId);
}
```

同时，由于 `ProblemBundleManifest.runtime_config` 变为可选，`updateExisting` 和 `createViaCrud` 中所有 `manifest.runtime_config` 的使用需要加非空断言 `manifest.runtime_config!`（这些函数只在非客观题分支被调用，已保证存在）。精确替换点：

- `updateExisting` 中：
  - `assertSensitiveFieldPermissions(c, actor.userId, actor.userRole, manifest.runtime_config!)`
  - `enforceResourceLimits(manifest.runtime_config!)`
  - `updateProblem(... { runtime_config: manifest.runtime_config!, ... })`
- `createViaCrud` 中：
  - `validateJudgeImageWithKind(manifest.runtime_config!.evaluator.image, "evaluator")`
  - `validateJudgeImageWithKind(manifest.runtime_config!.solution.image, "solution")`
  - `assertSensitiveFieldPermissions(c, actor.userId, actor.userRole, manifest.runtime_config!)`
  - `enforceResourceLimits(manifest.runtime_config!)`
  - `db.insert(problems).values({ ... runtime_config: manifest.runtime_config!, ... })`

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && BCRYPT_SALT_ROUNDS=4 env -u DATABASE_URL deno test -A --no-check --preload=tests/preload.ts tests/routes/problem-bundle.test.ts`
Expected: PASS

- [ ] **Step 5: 运行 fmt/lint**

Run: `deno fmt noj-core/src/services/problems/problem-bundle.ts noj-core/tests/routes/problem-bundle.test.ts && deno lint noj-core/src/services/problems/problem-bundle.ts noj-core/tests/routes/problem-bundle.test.ts`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
jj describe -m "feat(core): 统一题目包导入服务支持客观题套卷（事务性创建/更新 + 全量替换小题）"
```

---

### Task 4: 更新 OpenSpec 规范（已废弃）

> OpenSpec 已从仓库移除，本任务不再执行；客观题套卷导入行为由实现代码、测试与 noj-docs 文档覆盖。

---

### Task 5: 更新 noj-docs 文档

**Files:**
- Modify: `noj-docs/docs/standards/problem-bundle.md`
- Modify: `noj-docs/docs/features/objective.md`

**Interfaces:**
- 无代码接口；文档同步。

- [ ] **Step 1: 修改 `noj-docs/docs/standards/problem-bundle.md`**

- 在“包结构”代码块中增加客观题包示例：

```text
客观题套卷包（is_objective=true）：
├── problem.json      # 必需：manifest（is_objective: true）
├── questions.json    # 必需：小题数组
└── statement.md      # 可选：套卷说明
```

- 在 manifest 字段表中增加 `is_objective` 行：

```text
| `is_objective` | ❌ | 布尔值，缺省 `false`；`true` 表示客观题套卷包，不要求 `runtime_config`/`evaluate.py`，必须含 `questions.json` |
```

- 将“特殊题型”下的“客观题套卷”段落从“不通过统一题目包导入”改为：

```text
### 客观题套卷

客观题套卷（`is_objective=true`）支持通过统一题目包导入：`problem.json` 中声明 `"is_objective": true`，根级提供 `questions.json`（小题数组），不要求 `evaluate.py` / `runtime_config`。导入时系统创建/更新套卷并全量替换小题，不产生评测包存储，也不自动重测历史提交。

`questions.json` 示例：

```json
[
  {
    "type": "single",
    "prompt": "1+1=?",
    "options": [{ "key": "A", "text": "2" }, { "key": "B", "text": "3" }],
    "answer": ["A"],
    "explanation": "因为 1+1=2"
  }
]
```
```

- [ ] **Step 2: 修改 `noj-docs/docs/features/objective.md`**

将“客观题没有 `runtime_config` 与支持包，不通过统一题目包导入。”改为：

```text
客观题没有 `runtime_config` 与支持包，但支持通过统一题目包导入（`problem.json` 声明 `is_objective: true` + 根级 `questions.json`），用于批量创建/更新套卷。
```

- [ ] **Step 3: 构建文档站验证**

Run: `cd noj-docs && npm run docs:build`
Expected: 构建成功，无死链。

- [ ] **Step 4: Commit**

```bash
jj describe -m "docs(noj-docs): 客观题套卷支持统一题目包导入"
```

---

### Task 6: 全量验证

**Files:**
- 无新增/修改。

**Interfaces:**
- 验证所有任务集成。

- [ ] **Step 1: 运行 noj-core 全量测试**

Run: `cd noj-core && deno task test:parallel`
Expected: 全部通过。

- [ ] **Step 2: 运行 fmt/lint**

Run: `cd noj-core && deno fmt --check && deno lint`
Expected: 无错误。

- [ ] **Step 3: 运行文档构建**

Run: `cd noj-docs && npm run docs:build`
Expected: 构建成功。

- [ ] **Step 4: 检查文档无旧表述残留**

Run: `grep -R "客观题套卷不通过统一题目包导入" -n noj-docs docs || true`
Expected: 无匹配。

- [ ] **Step 5: Commit（如有未提交改动）**

```bash
jj status
jj describe -m "chore(root): 客观题套卷加入统一题目包全量验证"
```

---

## Self-Review

- **Spec coverage:** 格式（Task 1/2）、导入流程（Task 3）、CLI 构建/导入（无需代码改动，Task 3 复用 `importProblemBundle`，Task 5 文档说明）、规范/文档（Task 4/5）、测试（Task 1/2/3）、不自动重测（Task 3 注释 + Task 4 规范）。
- **Placeholder scan:** 所有代码步骤均含实际代码；无 TBD/TODO。
- **Type consistency:** `ProblemBundleManifest.runtime_config` 改为可选后，非客观题路径统一使用 `manifest.runtime_config!`；`validateObjectiveQuestions` 返回 `CreateQuestionInput[]`，Task 3 使用 `CreateQuestionInput` 类型；`ParsedProblemBundle.questions` 为 `unknown | null`，Task 3 传给 `validateObjectiveQuestions`。
