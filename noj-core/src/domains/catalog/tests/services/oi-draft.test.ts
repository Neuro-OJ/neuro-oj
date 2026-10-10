/**
 * OI 草稿写入与来源化读取测试（Handbook §6.3）。
 *
 * 验证：
 * - 配置 + 逐文件引用 + 打包 ZIP 在同一次草稿事务中切换（revision 只涨一次）；
 * - metadata-only 保存复用引用并校验新配置引用路径；
 * - 读取显式区分 draft / version 来源，历史版本数据不随草稿变化；
 * - revision 乐观锁（428 / 409）；
 * - ZIP 打包期间草稿被他人改动时，陈旧结果被拒绝且不留悬挂存储对象。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  problemDraftObjects,
  problems,
  storageObjects,
} from "../../../../shared/db/schema.ts";
import {
  listDraftOiFileRefs,
  loadOiDataFromDraft,
  loadOiDataFromVersion,
  saveOiDraft,
} from "../../services/versioning/oi-draft.ts";
import { getProblemDraft } from "../../services/versioning/draft.ts";
import { publishProblemVersion } from "../../services/versioning/publish.ts";
import { setStorageProviderForTest } from "../../../system/services/storage/factory.ts";
import { LocalStorageProvider } from "../../../system/services/storage/local.ts";
import type { OiRuntimeConfig } from "../../types/runtime-config.ts";

const now = new Date().toISOString();
const tempStorageDir = Deno.makeTempDirSync({ prefix: "noj-oi-draft-" });

function useTempStorage(): void {
  setStorageProviderForTest(new LocalStorageProvider(tempStorageDir));
}

async function seedOiProblem(id: string, number: number): Promise<void> {
  await getDb().insert(problems).values({
    id,
    title: "OI 题",
    description: "d",
    type: "P",
    number,
    owner_id: "0",
    difficulty: "easy",
    judge_type: "oi",
    created_at: now,
    updated_at: now,
  });
}

function oiConfig(input = "1.in", output = "1.out"): OiRuntimeConfig {
  return {
    backend: "native",
    languages: ["c", "cc"],
    time_limit_ms: 1000,
    memory_limit_mb: 256,
    checker: { type: "default" },
    subtasks: [
      {
        id: "s1",
        score: 100,
        cases: [{ input, output }],
      },
    ],
  };
}

function entriesOf(map: Record<string, string>): Record<string, Uint8Array> {
  const encoder = new TextEncoder();
  const out: Record<string, Uint8Array> = Object.create(null);
  for (const [path, text] of Object.entries(map)) {
    out[path] = encoder.encode(text);
  }
  return out;
}

function decode(files: Record<string, Uint8Array>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(files)) {
    out[path] = new TextDecoder().decode(bytes);
  }
  return out;
}

Deno.test("oi draft: 保存文件与配置只递增一次 revision", async () => {
  useTempStorage();
  await seedOiProblem("oid-p1", 960001);
  const result = await saveOiDraft("oid-p1", {
    runtime_config: oiConfig(),
    expectedRevision: 0,
    actorId: "0",
  }, entriesOf({ "1.in": "input-1", "1.out": "output-1" }));

  assertEquals(result.revision, 1);
  assertEquals(result.files_changed, true);

  // 逐文件引用 + 打包 ZIP 都已写入
  const refs = await listDraftOiFileRefs("oid-p1");
  assertEquals(refs.map((ref) => ref.path), ["1.in", "1.out"]);

  const loaded = await loadOiDataFromDraft("oid-p1");
  assertEquals(decode(loaded), { "1.in": "input-1", "1.out": "output-1" });
});

Deno.test("oi draft: metadata-only 保存复用文件引用并校验引用路径", async () => {
  useTempStorage();
  await seedOiProblem("oid-p2", 960002);
  await saveOiDraft("oid-p2", {
    runtime_config: oiConfig(),
    expectedRevision: 0,
  }, entriesOf({ "1.in": "a", "1.out": "b" }));

  const before = await listDraftOiFileRefs("oid-p2");
  // 只改配置（引用路径不变）→ 复用，不重传
  const updated = await saveOiDraft("oid-p2", {
    runtime_config: { ...oiConfig(), time_limit_ms: 2000 },
    expectedRevision: 1,
  });
  assertEquals(updated.files_changed, false);
  assertEquals(updated.revision, 2);
  const after = await listDraftOiFileRefs("oid-p2");
  assertEquals(
    after.map((ref) => ref.storage_url),
    before.map((ref) => ref.storage_url),
  );

  // 新配置引用了不存在的文件 → 拒绝
  await assertRejects(
    () =>
      saveOiDraft("oid-p2", {
        runtime_config: oiConfig("9.in", "9.out"),
        expectedRevision: 2,
      }),
    Error,
    "配置引用缺失文件",
  );
});

Deno.test("oi draft: revision 乐观锁（428 / 409）", async () => {
  useTempStorage();
  await seedOiProblem("oid-p3", 960003);
  await assertRejects(
    () =>
      saveOiDraft("oid-p3", {
        runtime_config: oiConfig(),
        expectedRevision: null,
      }),
    Error,
    "If-Match",
  );
  await saveOiDraft("oid-p3", {
    runtime_config: oiConfig(),
    expectedRevision: 0,
  }, entriesOf({ "1.in": "a", "1.out": "b" }));
  // 过时 revision
  await assertRejects(() =>
    saveOiDraft("oid-p3", {
      runtime_config: oiConfig(),
      expectedRevision: 0,
    })
  );
});

Deno.test("oi draft: 发布后版本数据与草稿分离", async () => {
  useTempStorage();
  await seedOiProblem("oid-p4", 960004);
  await saveOiDraft("oid-p4", {
    runtime_config: oiConfig(),
    expectedRevision: 0,
  }, entriesOf({ "1.in": "v1-input", "1.out": "v1-output" }));
  const published = await publishProblemVersion("oid-p4", {
    expectedRevision: 1,
  });

  // 草稿改成 v2 数据并再发布草稿版本（Revision 递增到 3）
  await saveOiDraft("oid-p4", {
    runtime_config: oiConfig(),
    expectedRevision: 2,
  }, entriesOf({ "1.in": "v2-input", "1.out": "v2-output" }));
  assertEquals(
    decode(await loadOiDataFromDraft("oid-p4")),
    { "1.in": "v2-input", "1.out": "v2-output" },
  );

  // 历史版本仍返回 v1 数据（进度重置/旧重测可用）
  const versionFiles = await loadOiDataFromVersion(published.version_id);
  assert(versionFiles["1.in"] !== undefined);
  assertEquals(decode(versionFiles), {
    "1.in": "v1-input",
    "1.out": "v1-output",
  });
});

Deno.test("oi draft: 打包期间草稿被他人改动 → 陈旧 ZIP 被拒绝且不留悬挂对象", async () => {
  useTempStorage();
  await seedOiProblem("oid-p5", 960005);
  // 基线草稿（revision 1）
  await saveOiDraft("oid-p5", {
    runtime_config: oiConfig(),
    expectedRevision: 0,
  }, entriesOf({ "1.in": "base-in", "1.out": "base-out" }));
  const baselineRefs = await listDraftOiFileRefs("oid-p5");
  const baselinePackage = await draftPackageRef("oid-p5");

  // 并发编辑：另一次保存把 revision 推到 2（模拟"ZIP 打包期间草稿已变化"）
  await saveOiDraft("oid-p5", {
    runtime_config: { ...oiConfig(), time_limit_ms: 3000 },
    expectedRevision: 1,
  });

  // 陈旧调用携带 revision 1：ZIP 已经打包上传，但提交必须被 409 拒绝
  await assertRejects(() =>
    saveOiDraft("oid-p5", {
      runtime_config: oiConfig(),
      expectedRevision: 1,
    }, entriesOf({ "1.in": "stale-in", "1.out": "stale-out" }))
  );

  // 草稿内容仍是并发写入者的版本（陈旧 ZIP 没有覆盖它）
  const draft = await getProblemDraft("oid-p5");
  assertEquals(draft.revision, 2);
  assertEquals(
    (draft.content as unknown as { runtime_config: OiRuntimeConfig })
      .runtime_config.time_limit_ms,
    3000,
  );
  assertEquals(
    decode(await loadOiDataFromDraft("oid-p5")),
    { "1.in": "base-in", "1.out": "base-out" },
  );
  // 引用未被替换：陈旧上传的逐文件对象没有绑定到草稿
  assertEquals(
    (await listDraftOiFileRefs("oid-p5")).map((ref) => ref.storage_url),
    baselineRefs.map((ref) => ref.storage_url),
  );
  assertEquals(await draftPackageRef("oid-p5"), baselinePackage);
  // 上传补偿已回收陈旧对象：登记表中不存在"无人引用却没有进入删除流程"的残留
  const dangling = await getDb().select().from(storageObjects).where(
    and(
      eq(storageObjects.state, "ready"),
      sql`NOT EXISTS (
        SELECT 1 FROM problem_draft_objects d WHERE d.storage_url = ${storageObjects.storage_url}
        UNION ALL
        SELECT 1 FROM problem_version_objects v WHERE v.storage_url = ${storageObjects.storage_url}
      )`,
    ),
  );
  assertEquals(dangling.map((row) => row.storage_url), []);
});

/** 读取草稿的支持包（打包 ZIP）引用，用于确认"陈旧 ZIP 未替换引用"。 */
async function draftPackageRef(problemId: string): Promise<string | null> {
  const rows = await getDb().select().from(problemDraftObjects).where(
    and(
      eq(problemDraftObjects.problem_id, problemId),
      eq(problemDraftObjects.role, "support_package"),
    ),
  );
  return rows[0]?.storage_url ?? null;
}
