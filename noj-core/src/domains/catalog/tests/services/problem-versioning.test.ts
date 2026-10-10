/**
 * 草稿与发布服务测试（Handbook §2.4、§5.2、§5.3）。
 *
 * 覆盖：revision 乐观锁（428/409）、草稿不影响作答、发布分配版本与更新投影、
 * 相同内容不制造空版本、基线冲突、文件引用随版本固定、默认作答版本解析。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  problemDrafts,
  problems,
  problemVersionObjects,
} from "../../../../shared/db/schema.ts";
import {
  getProblemDraft,
  listDraftObjects,
  saveProblemDraft,
  setDraftObject,
} from "../../services/versioning/draft.ts";
import {
  getProblemVersionOrThrow,
  listProblemVersions,
  preflightProblemDraft,
  publishProblemVersion,
  resolveProblemAnswerVersion,
} from "../../services/versioning/publish.ts";
import { registerReadyStorageObject } from "../../../system/services/storage/registry.ts";
import { setStorageProviderForTest } from "../../../system/services/storage/factory.ts";
import { LocalStorageProvider } from "../../../system/services/storage/local.ts";
import type {
  AiProblemContent,
  ProblemDraftContent,
} from "../../types/problem-content.ts";

const now = new Date().toISOString();

/**
 * 本地 provider 的存储根目录由 `SUPPORT_PACKAGE_DIR` 决定（构造函数无参数），
 * 因此在模块加载时指向一次性临时目录，避免污染仓库的 data/storage。
 */
const tempStorageDir = Deno.makeTempDirSync({ prefix: "noj-publish-" });

/** 每个用例重置 provider 单例（同一临时目录，内容寻址互不干扰）。 */
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
    created_at: now,
    updated_at: now,
  });
}

/** 一份完整的 AI 内容。 */
function aiContent(title: string): ProblemDraftContent {
  return {
    kind: "ai",
    title,
    description: `${title} 的题面`,
    samples: [{ id: "s1", input: "1", output: "2" }],
    submission_mode: "code",
    runtime_config: {
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
    },
    template_content: "print(1)",
    artifact_max_size_mb: null,
    llm_config: null,
  } as unknown as ProblemDraftContent;
}

Deno.test("draft: 首次读取派生初值，保存递增 revision 并做乐观锁", async () => {
  await seedAiProblem("pv-draft-1", 920001);

  const initial = await getProblemDraft("pv-draft-1");
  assertEquals(initial.synthesized, true);
  assertEquals(initial.revision, 0);
  assertEquals(initial.content.kind, "ai");
  assertEquals(initial.base_version_id, null);

  // 缺少预期 revision → 428
  await assertRejects(
    () =>
      saveProblemDraft("pv-draft-1", {
        content: aiContent("V1"),
        expectedRevision: null,
        actorId: "0",
      }),
    Error,
    "If-Match",
  );

  const saved = await saveProblemDraft("pv-draft-1", {
    content: aiContent("V1"),
    expectedRevision: 0,
    actorId: "0",
  });
  assertEquals(saved.revision, 1);
  assertEquals(saved.synthesized, false);

  // 过时 revision → 409
  await assertRejects(() =>
    saveProblemDraft("pv-draft-1", {
      content: aiContent("V1b"),
      expectedRevision: 0,
      actorId: "0",
    })
  );

  const again = await saveProblemDraft("pv-draft-1", {
    content: aiContent("V1b"),
    expectedRevision: 1,
    actorId: "0",
  });
  assertEquals(again.revision, 2);

  // 草稿保存不改变题目投影（最新版指针与内容字段都不动）
  const [row] = await getDb().select().from(problems).where(
    eq(problems.id, "pv-draft-1"),
  );
  assertEquals(row.latest_version_id, null);
  assertEquals(row.title, "初始标题");
});

Deno.test("publish: 内容不完整时预检拒绝，不产生版本", async () => {
  await seedAiProblem("pv-pub-incomplete", 920002);
  await saveProblemDraft("pv-pub-incomplete", {
    content: {
      kind: "ai",
      title: "缺配置",
      description: "d",
      samples: [],
    },
    expectedRevision: 0,
    actorId: "0",
  });
  const preflight = await preflightProblemDraft("pv-pub-incomplete");
  assertEquals(preflight.ready, false);
  assertEquals(preflight.content_complete, false);
  assert(preflight.errors.some((issue) => issue.code === "CONTENT_INCOMPLETE"));

  await assertRejects(
    () => publishProblemVersion("pv-pub-incomplete", { expectedRevision: 1 }),
    Error,
    "发布预检未通过",
  );
  const { total } = await listProblemVersions("pv-pub-incomplete");
  assertEquals(total, 0);
});

Deno.test("publish: 发布成功分配 V1、更新最新版投影与草稿基线", async () => {
  useTempStorage();
  await seedAiProblem("pv-pub-ok", 920003);
  await saveProblemDraft("pv-pub-ok", {
    content: aiContent("第一版"),
    expectedRevision: 0,
    actorId: "0",
  });

  const result = await publishProblemVersion("pv-pub-ok", {
    expectedRevision: 1,
    changeNote: "首次发布",
    actorId: "0",
  });
  assertEquals(result.unchanged, false);
  assertEquals(result.version, 1);
  assertEquals(result.draft_revision, 2);

  const [row] = await getDb().select().from(problems).where(
    eq(problems.id, "pv-pub-ok"),
  );
  assertEquals(row.latest_version_id, result.version_id);
  assertEquals(row.title, "第一版");
  assertEquals(row.updated_at !== now, true);

  const [draftRow] = await getDb().select().from(problemDrafts).where(
    eq(problemDrafts.problem_id, "pv-pub-ok"),
  );
  assertEquals(draftRow.base_version_id, result.version_id);
  assertEquals(draftRow.revision, 2);

  // 版本可读，且标记为最新版
  const version = await getProblemVersionOrThrow(
    "pv-pub-ok",
    result.version_id,
  );
  assertEquals(version.version, 1);
  assertEquals(version.origin, "published");
  assertEquals(version.change_note, "首次发布");
  assert(version.content_sha256 && version.content_sha256.length === 64);

  const list = await listProblemVersions("pv-pub-ok");
  assertEquals(list.total, 1);
  assertEquals(list.data[0].is_latest, true);

  // 默认作答版本：any → 最新版
  const answer = await resolveProblemAnswerVersion("pv-pub-ok");
  assertEquals(answer?.version_id, result.version_id);
  assertEquals(answer?.is_latest, true);
});

Deno.test("publish: 相同内容重复发布返回 unchanged，不制造空版本", async () => {
  useTempStorage();
  await seedAiProblem("pv-pub-same", 920004);
  const content = aiContent("同内容");
  await saveProblemDraft("pv-pub-same", {
    content,
    expectedRevision: 0,
    actorId: "0",
  });
  const first = await publishProblemVersion("pv-pub-same", {
    expectedRevision: 1,
  });

  // 再次发布同一内容（草稿 revision 已被发布递增为 2）
  const second = await publishProblemVersion("pv-pub-same", {
    expectedRevision: 2,
    changeNote: "换个说明但内容相同",
  });
  assertEquals(second.unchanged, true);
  assertEquals(second.version_id, first.version_id);
  assertEquals(second.version, 1);
  const { total } = await listProblemVersions("pv-pub-same");
  assertEquals(total, 1);
});

Deno.test("publish: 同内容不同草稿修订也算 unchanged（哈希不含说明/时间）", async () => {
  useTempStorage();
  await seedAiProblem("pv-pub-hash", 920005);
  await saveProblemDraft("pv-pub-hash", {
    content: aiContent("哈希稳定"),
    expectedRevision: 0,
  });
  const first = await publishProblemVersion("pv-pub-hash", {
    expectedRevision: 1,
  });
  // 草稿 revision 2 → 修改后改回相同内容（revision 3）→ 仍为 unchanged
  await saveProblemDraft("pv-pub-hash", {
    content: aiContent("哈希稳定-临时"),
    expectedRevision: 2,
  });
  await saveProblemDraft("pv-pub-hash", {
    content: aiContent("哈希稳定"),
    expectedRevision: 3,
  });
  const third = await publishProblemVersion("pv-pub-hash", {
    expectedRevision: 4,
  });
  assertEquals(third.unchanged, true);
  assertEquals(third.version_id, first.version_id);
});

Deno.test("publish: revision 过时与基线冲突都返回 409", async () => {
  useTempStorage();
  await seedAiProblem("pv-pub-conflict", 920006);
  await saveProblemDraft("pv-pub-conflict", {
    content: aiContent("冲突"),
    expectedRevision: 0,
  });
  const published = await publishProblemVersion("pv-pub-conflict", {
    expectedRevision: 1,
  });

  // revision 过时（当前 2）→ 409
  await assertRejects(() =>
    publishProblemVersion("pv-pub-conflict", { expectedRevision: 1 })
  );

  // 基线被人为改回 null（模拟"另一个人已发布过别的版本"）→ 409
  await getDb().update(problemDrafts).set({ base_version_id: null }).where(
    eq(problemDrafts.problem_id, "pv-pub-conflict"),
  );
  await assertRejects(
    () => publishProblemVersion("pv-pub-conflict", { expectedRevision: 2 }),
    Error,
    "基线",
  );
  // 版本没被新增
  const { total } = await listProblemVersions("pv-pub-conflict");
  assertEquals(total, 1);
  assertEquals(published.version, 1);
});

Deno.test("publish: 文件引用复制到版本，草稿后续替换不影响历史版本", async () => {
  const provider = useTempStorage();
  await seedAiProblem("pv-pub-files", 920007);
  const v1Bytes = new TextEncoder().encode("package-v1");
  const urlV1 = await provider.put("pkg-v1", v1Bytes);
  await registerReadyStorageObject({
    storageUrl: urlV1,
    sha256: "sha-v1",
    byteSize: v1Bytes.length,
  });
  await setDraftObject("pv-pub-files", {
    role: "support_package",
    path: "package.zip",
    storage_url: urlV1,
  });
  await saveProblemDraft("pv-pub-files", {
    content: aiContent("带文件"),
    expectedRevision: 0,
  });

  const preflight = await preflightProblemDraft("pv-pub-files", {
    verifyObjects: true,
  });
  assertEquals(preflight.ready, true);
  assertEquals(preflight.files.length, 1);
  assertEquals(preflight.files[0].exists, true);

  const first = await publishProblemVersion("pv-pub-files", {
    expectedRevision: 1,
  });
  const versionObjects = await getDb().select().from(problemVersionObjects)
    .where(eq(problemVersionObjects.version_id, first.version_id));
  assertEquals(versionObjects.length, 1);
  assertEquals(versionObjects[0].storage_url, urlV1);

  // 题目投影同步支持包 URL（既有读取路径不受影响）
  const [row] = await getDb().select().from(problems).where(
    eq(problems.id, "pv-pub-files"),
  );
  assertEquals(row.support_package_storage_url, urlV1);

  // 草稿替换成新对象后，历史版本引用保持不变
  const v2Bytes = new TextEncoder().encode("package-v2");
  const urlV2 = await provider.put("pkg-v2", v2Bytes);
  await registerReadyStorageObject({
    storageUrl: urlV2,
    sha256: "sha-v2",
    byteSize: v2Bytes.length,
  });
  await setDraftObject("pv-pub-files", {
    role: "support_package",
    path: "package.zip",
    storage_url: urlV2,
  });
  const draftObjects = await listDraftObjects("pv-pub-files");
  assertEquals(draftObjects[0].storage_url, urlV2);
  const stillV1 = await getDb().select().from(problemVersionObjects)
    .where(eq(problemVersionObjects.version_id, first.version_id));
  assertEquals(stillV1[0].storage_url, urlV1);

  // 第二次发布（内容相同但文件哈希不同 → 是新版本）
  const second = await publishProblemVersion("pv-pub-files", {
    expectedRevision: 2,
  });
  assertEquals(second.unchanged, false);
  assertEquals(second.version, 2);
});

Deno.test("publish: 未发布题目没有默认作答版本", async () => {
  await seedAiProblem("pv-unpublished", 920008);
  assertEquals(await resolveProblemAnswerVersion("pv-unpublished"), null);
});

Deno.test("publish: exact 策略下默认作答版本取要求版本", async () => {
  useTempStorage();
  await seedAiProblem("pv-exact", 920009);
  await saveProblemDraft("pv-exact", {
    content: aiContent("exact 版"),
    expectedRevision: 0,
  });
  const v1 = await publishProblemVersion("pv-exact", { expectedRevision: 1 });
  // 发布第二版
  await saveProblemDraft("pv-exact", {
    content: aiContent("exact 版二"),
    expectedRevision: 2,
  });
  const v2 = await publishProblemVersion("pv-exact", { expectedRevision: 3 });
  assertEquals(v2.version, 2);

  // any → 最新版
  const anyAnswer = await resolveProblemAnswerVersion("pv-exact");
  assertEquals(anyAnswer?.version_id, v2.version_id);

  // exact(V1) → 要求版本（且不是最新版）
  await getDb().update(problems).set({
    effective_version_mode: "exact",
    required_version_id: v1.version_id,
    effective_policy_revision: 1,
  }).where(eq(problems.id, "pv-exact"));
  const exactAnswer = await resolveProblemAnswerVersion("pv-exact");
  assertEquals(exactAnswer?.version_id, v1.version_id);
  assertEquals(exactAnswer?.is_latest, false);
  assertEquals(
    (exactAnswer?.content as AiProblemContent).title,
    "exact 版",
  );
});
