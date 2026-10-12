/**
 * 草稿/发布硬化测试（tracking #16、#18、#20、#21、#22、#23、#24、#55）。
 *
 * 覆盖发布链路上"看起来成功、实际不一致"的几类缺陷：
 * - 文件实际 SHA 未知时不得参与内容哈希（否则不同字节被误判 unchanged）——#22；
 * - 审计与搜索索引必须随发布事务持久化（进程崩溃也不丢）——#23；
 * - 预检报告必须绑定草稿 revision 与文件集合，预检后换包不能发布——#20；
 * - `unchanged` 只与当前最新版比较，改回历史内容必须产生新版本——#21；
 * - 迁移题的首次草稿物化必须继承基线文件引用——#24；
 * - 客观题包导入不能把已发布编程题改成客观题，也不能提前改写公开投影——#18；
 * - 编辑器支持包上传必须写**目标题目**的共享草稿并校验 revision——#55；
 * - 草稿运行配置的结构校验与敏感字段权限（发布入口同口径）——#16。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { zipSync } from "fflate";
import { and, eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  auditLogs,
  problemDraftObjects,
  problemDrafts,
  problems,
  problemVersionObjects,
  problemVersions,
  searchEntries,
  storageObjects,
} from "../../../../shared/db/schema.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import {
  draftRevisionRequired,
  getProblemDraft,
  listDraftObjects,
  saveProblemDraft,
  setDraftObject,
} from "../../services/versioning/draft.ts";
import {
  preflightProblemDraft,
  publishProblemVersion,
} from "../../services/versioning/publish.ts";
import { importProblemBundle } from "../../services/problems/problem-bundle.ts";
import { assertDraftContentSecurity } from "../../services/versioning/content-security.ts";
import { registerReadyStorageObject } from "../../../system/services/storage/registry.ts";
import { setStorageProviderForTest } from "../../../system/services/storage/factory.ts";
import { LocalStorageProvider } from "../../../system/services/storage/local.ts";
import { buildStorageUrl } from "../../../system/services/storage/types.ts";
import type { ProblemDraftContent } from "../../types/problem-content.ts";

const now = new Date().toISOString();
await resetDbForTest();

const tempStorageDir = Deno.makeTempDirSync({
  prefix: "noj-publish-hardening-",
});

function useTempStorage(): LocalStorageProvider {
  const provider = new LocalStorageProvider(tempStorageDir);
  setStorageProviderForTest(provider);
  return provider;
}

/** 插入一道 AI（dual/code）题目身份行。 */
async function seedAiProblem(id: string, number: number): Promise<void> {
  await getDb().insert(problems).values({
    id,
    title: "初始标题",
    description: "初始题面",
    type: "P",
    number,
    owner_id: "0",
    difficulty: "easy",
    judge_type: "dual",
    submission_mode: "code",
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
}

/** 完整 AI 草稿内容。 */
function aiContent(template = "print(1)"): ProblemDraftContent {
  return {
    kind: "ai",
    title: "题目标题",
    description: "题面",
    samples: [],
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
    template_content: template,
    artifact_max_size_mb: null,
    llm_config: null,
  } as unknown as ProblemDraftContent;
}

/** 构造客观题题包 zip。 */
function objectiveZip(number: number): Uint8Array {
  const enc = new TextEncoder();
  return zipSync({
    "problem.json": enc.encode(JSON.stringify({
      format_version: 1,
      title: `客观题包 ${number}`,
      difficulty: "easy",
      type: "P",
      number,
      is_objective: true,
    })),
    "questions.json": enc.encode(JSON.stringify([
      {
        type: "single",
        prompt: "1+1=?",
        options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
        answer: ["A"],
      },
    ])),
    "statement.md": enc.encode("# 客观题包\n"),
  }, { level: 6 });
}

Deno.test("publish hardening #24: 首次保存草稿继承基线的版本文件引用", async () => {
  const provider = useTempStorage();
  await seedAiProblem("ph-base-refs", 950001);
  const bytes = new TextEncoder().encode("baseline-package");
  const url = await provider.put("ph-baseline", bytes);
  await setDraftObject("ph-base-refs", {
    role: "support_package",
    path: "package.zip",
    storage_url: url,
  });
  await saveProblemDraft("ph-base-refs", {
    content: aiContent(),
    expectedRevision: 0,
    actorId: "0",
  });
  const published = await publishProblemVersion("ph-base-refs", {
    expectedRevision: 1,
    actorId: "0",
  });
  assertEquals(published.version, 1);

  // 模拟存量迁移状态：版本文件引用存在，但**没有**草稿行/草稿引用
  await getDb().delete(problemDraftObjects).where(
    eq(problemDraftObjects.problem_id, "ph-base-refs"),
  );
  await getDb().delete(problemDrafts).where(
    eq(problemDrafts.problem_id, "ph-base-refs"),
  );
  assertEquals((await listDraftObjects("ph-base-refs")).length, 0);

  // 首次编辑：必须在同一事务里把基线引用复制进草稿引用表，否则支持包静默丢失
  await saveProblemDraft("ph-base-refs", {
    content: { ...aiContent(), title: "改过的题面" },
    expectedRevision: 0,
    actorId: "0",
  });
  const refs = await listDraftObjects("ph-base-refs");
  assertEquals(refs.length, 1);
  assertEquals(refs[0].role, "support_package");
  assertEquals(refs[0].storage_url, url);
});

Deno.test("publish hardening #22: 文件实际 SHA 未知时拒绝发布", async () => {
  const provider = useTempStorage();
  await seedAiProblem("ph-sha", 950002);
  const bytes = new TextEncoder().encode("sha-package");
  // 写盘后使用**不带 checksum** 的存储 URL：登记哈希为空 → 无法取得实际 SHA
  await provider.put("ph-sha-obj", bytes);
  const bareUrl = buildStorageUrl("local", "ph-sha-obj");
  await getDb().insert(storageObjects).values({
    storage_url: bareUrl,
    sha256: null,
    byte_size: bytes.length,
    state: "unknown",
    created_at: now,
  });
  await setDraftObject("ph-sha", {
    role: "support_package",
    path: "package.zip",
    storage_url: bareUrl,
  });
  await saveProblemDraft("ph-sha", {
    content: aiContent(),
    expectedRevision: 0,
    actorId: "0",
  });

  const preflight = await preflightProblemDraft("ph-sha", {
    verifyObjects: true,
  });
  assertEquals(preflight.ready, false);
  assertEquals(
    preflight.errors.some((error) =>
      error.code === "STORAGE_OBJECT_SHA_UNKNOWN"
    ),
    true,
  );
  assertEquals(preflight.content_hash, null);

  await assertRejects(
    () => publishProblemVersion("ph-sha", { expectedRevision: 1 }),
    AppError,
    "SHA",
  );
  const versions = await getDb().select().from(problemVersions).where(
    eq(problemVersions.problem_id, "ph-sha"),
  );
  assertEquals(versions.length, 0);
});

Deno.test("publish hardening #22: URL 携带 checksum 时补齐登记哈希并可发布", async () => {
  const provider = useTempStorage();
  await seedAiProblem("ph-sha-ok", 950003);
  const bytes = new TextEncoder().encode("sha-ok-package");
  const url = await provider.put("ph-sha-ok-obj", bytes);
  await registerReadyStorageObject({
    storageUrl: url,
    sha256: null,
    byteSize: bytes.length,
  });
  await setDraftObject("ph-sha-ok", {
    role: "support_package",
    path: "package.zip",
    storage_url: url,
  });
  await saveProblemDraft("ph-sha-ok", {
    content: aiContent(),
    expectedRevision: 0,
    actorId: "0",
  });

  const preflight = await preflightProblemDraft("ph-sha-ok", {
    verifyObjects: true,
  });
  assertEquals(preflight.ready, true);
  assertEquals(typeof preflight.files[0].sha256, "string");

  const published = await publishProblemVersion("ph-sha-ok", {
    expectedRevision: 1,
    actorId: "0",
  });
  assertEquals(published.unchanged, false);
  // 版本文件引用与投影都带上该对象
  const versionRefs = await getDb().select().from(problemVersionObjects).where(
    eq(problemVersionObjects.version_id, published.version_id),
  );
  assertEquals(versionRefs.length, 1);
  const [objectRow] = await getDb().select().from(storageObjects).where(
    eq(storageObjects.storage_url, url),
  );
  assertEquals(typeof objectRow.sha256, "string");
});

Deno.test("publish hardening #23: 审计与搜索索引随发布事务持久化", async () => {
  await seedAiProblem("ph-outbox", 950004);
  await saveProblemDraft("ph-outbox", {
    content: aiContent(),
    expectedRevision: 0,
    actorId: "0",
  });

  const published = await publishProblemVersion("ph-outbox", {
    expectedRevision: 1,
    actorId: "0",
    changeNote: "首个版本",
  });
  assertEquals(published.version, 1);

  // 审计行：与版本同事务写入（无 Redis/消费者参与）
  const audits = await getDb().select().from(auditLogs).where(
    and(
      eq(auditLogs.action, "problems.version_published"),
      eq(auditLogs.target_id, "ph-outbox"),
    ),
  );
  assertEquals(audits.length, 1);
  assertEquals(
    (audits[0].detail as Record<string, unknown>).version_id,
    published.version_id,
  );

  // 搜索索引：已发布题目必须在同一事务内可查到（否则"已发布但索引永久缺失"）
  const entries = await getDb().select().from(searchEntries).where(
    and(
      eq(searchEntries.entity_type, "problem"),
      eq(searchEntries.entity_id, "ph-outbox"),
    ),
  );
  assertEquals(entries.length, 1);
  assertEquals(entries[0].title, "题目标题");
});

/**
 * #20：文件引用替换必须与预检绑定。
 *
 * 发布入口在锁外预检、锁内**重算内容哈希**并与预检报告比对，因此"预检 A 文件、
 * 发布 B 文件"不可能发生：预检之后替换引用（不递增 revision）时，发布只会固定
 * **当前**引用集合（B），绝不会把预检时的 A 写进版本。
 */
Deno.test("publish hardening #20: 预检后替换文件引用不得发布预检对象", async () => {
  const provider = useTempStorage();
  await seedAiProblem("ph-rev-bind", 950005);
  const bytesA = new TextEncoder().encode("package-A");
  const urlA = await provider.put("ph-a", bytesA);
  await registerReadyStorageObject({
    storageUrl: urlA,
    byteSize: bytesA.length,
  });
  await setDraftObject("ph-rev-bind", {
    role: "support_package",
    path: "package.zip",
    storage_url: urlA,
  });
  await saveProblemDraft("ph-rev-bind", {
    content: aiContent(),
    expectedRevision: 0,
    actorId: "0",
  });

  const preflight = await preflightProblemDraft("ph-rev-bind", {
    verifyObjects: true,
  });
  assertEquals(preflight.ready, true);
  assertEquals(preflight.files.length, 1);

  // 预检之后替换支持包（只换引用，内容与 revision 都不变）
  const bytesB = new TextEncoder().encode("package-B");
  const urlB = await provider.put("ph-b", bytesB);
  await registerReadyStorageObject({
    storageUrl: urlB,
    byteSize: bytesB.length,
  });
  await setDraftObject("ph-rev-bind", {
    role: "support_package",
    path: "package.zip",
    storage_url: urlB,
  });

  const published = await publishProblemVersion("ph-rev-bind", {
    expectedRevision: preflight.revision,
  });
  assertEquals(published.unchanged, false);
  const versionRefs = await getDb().select().from(problemVersionObjects).where(
    eq(problemVersionObjects.version_id, published.version_id),
  );
  assertEquals(versionRefs.length, 1);
  assertEquals(
    versionRefs[0].storage_url,
    urlB,
    "版本必须固定锁内实际读到的引用（B），不能是预检时的 A",
  );

  // revision 乐观锁：陈旧的 expectedRevision 一律 409
  await assertRejects(
    () => publishProblemVersion("ph-rev-bind", { expectedRevision: 1 }),
    AppError,
    "revision",
  );
});

Deno.test("publish hardening #21: 改回历史内容生成新版本而不是 unchanged", async () => {
  await seedAiProblem("ph-aba", 950006);
  await saveProblemDraft("ph-aba", {
    content: aiContent("print('A')"),
    expectedRevision: 0,
    actorId: "0",
  });
  const v1 = await publishProblemVersion("ph-aba", {
    expectedRevision: 1,
    actorId: "0",
  });
  assertEquals(v1.version, 1);

  await saveProblemDraft("ph-aba", {
    content: aiContent("print('B')"),
    expectedRevision: 2,
    actorId: "0",
  });
  const v2 = await publishProblemVersion("ph-aba", {
    expectedRevision: 3,
    actorId: "0",
  });
  assertEquals(v2.version, 2);

  // 改回 A：内容与 V1 相同，但当前最新版是 V2 → 必须产生 V3
  await saveProblemDraft("ph-aba", {
    content: aiContent("print('A')"),
    expectedRevision: 4,
    actorId: "0",
  });
  const v3 = await publishProblemVersion("ph-aba", {
    expectedRevision: 5,
    actorId: "0",
  });
  assertEquals(v3.unchanged, false);
  assertEquals(v3.version, 3);

  // 最新版指针指向 V3
  const [row] = await getDb().select({
    latest: problems.latest_version_id,
  }).from(problems).where(eq(problems.id, "ph-aba"));
  assertEquals(row.latest, v3.version_id);

  // 再次发布同一内容才是 unchanged（与最新版比较）
  const again = await publishProblemVersion("ph-aba", {
    expectedRevision: 6,
  });
  assertEquals(again.unchanged, true);
  assertEquals(again.version_id, v3.version_id);
});

Deno.test("publish hardening #18: 客观题包不能导入到已发布编程题", async () => {
  await seedAiProblem("ph-kind", 950007);
  await saveProblemDraft("ph-kind", {
    content: aiContent(),
    expectedRevision: 0,
    actorId: "0",
  });
  const published = await publishProblemVersion("ph-kind", {
    expectedRevision: 1,
    actorId: "0",
  });
  assertEquals(published.version, 1);

  let code: string | undefined;
  try {
    await importProblemBundle(
      { name: "obj.zip", data: objectiveZip(950007) },
      { userId: "0", userRole: "admin" },
    );
  } catch (error) {
    code = (error as { code?: string }).code;
  }
  assertEquals(code, "CONTENT_KIND_IMMUTABLE");

  // 身份行与草稿内容零变化（不提前改写公开投影、不清空运行配置）
  const [row] = await getDb().select().from(problems).where(
    eq(problems.id, "ph-kind"),
  );
  assertEquals(row.is_objective, false);
  assertEquals(row.latest_version_id, published.version_id);
  assertEquals(row.runtime_config !== null, true);
  const draft = await getProblemDraft("ph-kind");
  assertEquals(draft.content.kind, "ai");
  assertEquals(draft.revision, 2);
});

Deno.test("publish hardening #55: 目标题目模式写草稿并校验 revision", async () => {
  useTempStorage();
  // 目标题目模式用于"编辑器上传支持包"：目标必须与包同题型（客观题包 → 客观题卷）
  const paperId = "ph-target";
  await getDb().insert(problems).values({
    id: paperId,
    title: "目标客观题卷",
    description: "题面",
    type: "P",
    number: 950008,
    owner_id: "0",
    difficulty: "easy",
    judge_type: "dual",
    is_objective: true,
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
  await saveProblemDraft(paperId, {
    content: {
      kind: "objective",
      title: "目标客观题卷",
      description: "题面",
      samples: [],
      questions: [{
        key: crypto.randomUUID(),
        sort_order: 0,
        type: "single",
        prompt: "1+1=?",
        options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
        answer: ["A"],
        explanation: "",
      }],
    } as unknown as ProblemDraftContent,
    expectedRevision: 0,
    actorId: "0",
  });
  await publishProblemVersion(paperId, { expectedRevision: 1, actorId: "0" });
  const before = await getDb().select({ id: problems.id }).from(problems);
  const revision = (await getProblemDraft(paperId)).revision;
  assertEquals(revision, 2);

  // 缺少编辑基线 → 428，且零写入
  await assertRejects(
    () =>
      importProblemBundle(
        { name: "obj-target.zip", data: objectiveZip(950008) },
        { userId: "0", userRole: "admin" },
        undefined,
        { problemId: paperId },
      ),
    Error,
    "If-Match",
  );
  // 过时 revision → 409
  await assertRejects(
    () =>
      importProblemBundle(
        { name: "obj-target.zip", data: objectiveZip(950008) },
        { userId: "0", userRole: "admin" },
        undefined,
        { problemId: paperId, expectedRevision: revision - 1 },
      ),
    AppError,
    "revision",
  );

  // 目标模式：包内 number 不参与匹配（此处包内 number 与目标一致，仅验证写入目标草稿）
  const result = await importProblemBundle(
    { name: "obj-target.zip", data: objectiveZip(950008) },
    { userId: "0", userRole: "admin" },
    undefined,
    { problemId: paperId, expectedRevision: revision },
  );
  assertEquals(result.id, paperId);
  const after = await getDb().select({ id: problems.id }).from(problems);
  assertEquals(after.length, before.length, "目标模式不得创建新题目");
  const draft = await getProblemDraft(paperId);
  assertEquals(draft.revision, revision + 1);
  assertEquals(draft.content.kind, "objective");
});

Deno.test("publish hardening #16: 草稿运行配置结构校验与敏感字段权限", async () => {
  await seedAiProblem("ph-draft-validate", 950009);

  // 类型错误（time_limit_ms 为字符串）必须立即 400，不能先落草稿
  await assertRejects(
    () =>
      saveProblemDraft("ph-draft-validate", {
        content: {
          ...aiContent(),
          runtime_config: {
            evaluator: {
              image: "noj-evaluator-python",
              command: "python3 /workspace/evaluate.py",
              time_limit_ms: "60000",
              memory_limit_mb: 512,
            },
            solution: {
              image: "noj-solution-python",
              call_timeout_ms: 60000,
              memory_limit_mb: 512,
            },
          },
        } as unknown as ProblemDraftContent,
        expectedRevision: 0,
        actorId: "0",
      }),
    Error,
    "time_limit_ms",
  );
  assertEquals((await getProblemDraft("ph-draft-validate")).revision, 0);

  // 草稿允许字段缺失（编辑中），但不允许 evaluator 不是对象
  await assertRejects(
    () =>
      assertDraftContentSecurity(
        {
          id: "ph-draft-validate",
          type: "P",
          runtime_config: null,
        } as unknown as Parameters<typeof assertDraftContentSecurity>[0],
        {
          kind: "ai",
          title: "t",
          description: "d",
          samples: [],
          runtime_config: "not-an-object",
        } as unknown as ProblemDraftContent,
        "0",
      ),
    Error,
    "对象",
  );
});

Deno.test("publish hardening: 草稿缺失 revision 的 428 语义", async () => {
  await seedAiProblem("ph-428", 950010);
  let error: unknown;
  try {
    await saveProblemDraft("ph-428", {
      content: aiContent(),
      expectedRevision: undefined,
      actorId: "0",
    });
  } catch (err) {
    error = err;
  }
  assertEquals(error instanceof AppError, true);
  assertEquals((error as AppError).status, draftRevisionRequired().status);
});
