/**
 * 支持包与题目版本的绑定测试（Handbook §2.5、§6.2）。
 *
 * 关键不变量：
 * - 下载/模板读取**绑定版本**：草稿替换或删除不影响历史版本交付；
 * - 删除草稿支持包不物理删除仍被历史版本引用的共享对象（引用守卫）；
 * - 未发布题目走迁移期投影兜底（存量兼容路径）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { problemDraftObjects, problems } from "../../../../shared/db/schema.ts";
import {
  deleteSupportPackage,
  getDraftSupportPackageUrl,
  getSupportPackageBytes,
  resolveProblemTemplate,
  resolveSupportPackageRef,
  setSupportPackage,
} from "../../services/support-package.ts";
import { saveProblemDraft } from "../../services/versioning/draft.ts";
import { publishProblemVersion } from "../../services/versioning/publish.ts";
import { setStorageProviderForTest } from "../../../system/services/storage/factory.ts";
import { LocalStorageProvider } from "../../../system/services/storage/local.ts";
import type { ProblemDraftContent } from "../../types/problem-content.ts";

const now = new Date().toISOString();
const tempStorageDir = Deno.makeTempDirSync({ prefix: "noj-support-" });
Deno.env.set("SUPPORT_PACKAGE_DIR", tempStorageDir);

function useTempStorage(): LocalStorageProvider {
  const provider = new LocalStorageProvider();
  setStorageProviderForTest(provider);
  return provider;
}

async function seedProblem(id: string, number: number): Promise<void> {
  await getDb().insert(problems).values({
    id,
    title: id,
    description: "d",
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

function aiContent(template: string): ProblemDraftContent {
  return {
    kind: "ai",
    title: "带包题目",
    description: "d",
    samples: [],
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
    template_content: template,
    artifact_max_size_mb: null,
    llm_config: null,
  } as unknown as ProblemDraftContent;
}

Deno.test("support package: 下载绑定已发布版本，草稿替换不影响历史", async () => {
  const provider = useTempStorage();
  await seedProblem("sp-p1", 940001);
  const bytesA = new TextEncoder().encode("package-A");
  const urlA = await provider.put("spA", bytesA);
  await setSupportPackage("sp-p1", {
    storageUrl: urlA,
    byteSize: bytesA.length,
  });

  // 草稿引用已就位，投影同步（未发布题目）
  assertEquals(await getDraftSupportPackageUrl("sp-p1"), urlA);
  const [row] = await getDb().select().from(problems).where(
    eq(problems.id, "sp-p1"),
  );
  assertEquals(row.support_package_storage_url, urlA);

  await saveProblemDraft("sp-p1", {
    content: aiContent("print(1)"),
    expectedRevision: 0,
  });
  const v1 = await publishProblemVersion("sp-p1", { expectedRevision: 1 });

  const ref = await resolveSupportPackageRef("sp-p1");
  assertEquals(ref?.source, "version");
  assertEquals(ref?.version_id, v1.version_id);
  assertEquals(ref?.storage_url, urlA);
  assertEquals(
    new TextDecoder().decode(
      (await getSupportPackageBytes("sp-p1", "0", "admin"))!,
    ),
    "package-A",
  );

  // 草稿替换成 B：最新版仍是 A
  const bytesB = new TextEncoder().encode("package-B");
  const urlB = await provider.put("spB", bytesB);
  await setSupportPackage("sp-p1", {
    storageUrl: urlB,
    byteSize: bytesB.length,
  });
  assertEquals(
    new TextDecoder().decode(
      (await getSupportPackageBytes("sp-p1", "0", "admin"))!,
    ),
    "package-A",
  );

  // 明确指定历史版本下载
  assertEquals(
    new TextDecoder().decode(
      (await getSupportPackageBytes("sp-p1", "0", "admin", undefined, {
        versionId: v1.version_id,
      }))!,
    ),
    "package-A",
  );

  // 发布第二版后下载切到 B
  const v2 = await publishProblemVersion("sp-p1", { expectedRevision: 2 });
  assertEquals(v2.version, 2);
  assertEquals(
    new TextDecoder().decode(
      (await getSupportPackageBytes("sp-p1", "0", "admin"))!,
    ),
    "package-B",
  );
});

Deno.test("support package: 删除草稿包不删除历史版本引用的对象", async () => {
  const provider = useTempStorage();
  await seedProblem("sp-p2", 940002);
  const bytes = new TextEncoder().encode("shared-package");
  const url = await provider.put("spShared", bytes);
  await setSupportPackage("sp-p2", { storageUrl: url, byteSize: bytes.length });
  await saveProblemDraft("sp-p2", {
    content: aiContent("t"),
    expectedRevision: 0,
  });
  await publishProblemVersion("sp-p2", { expectedRevision: 1 });

  await deleteSupportPackage("sp-p2", "0", "admin");

  // 草稿引用已移除，但历史版本仍引用 → 物理对象保留、下载仍可用
  assertEquals(await getDraftSupportPackageUrl("sp-p2"), null);
  assertEquals((await provider.stat(url)).exists, true);
  assertEquals(
    new TextDecoder().decode(
      (await getSupportPackageBytes("sp-p2", "0", "admin"))!,
    ),
    "shared-package",
  );
  // 投影不被草稿操作改写（内容事实源是版本）
  const [row] = await getDb().select().from(problems).where(
    eq(problems.id, "sp-p2"),
  );
  assertEquals(row.support_package_storage_url, url);

  // 草稿引用确实被清掉
  const draftRows = await getDb().select().from(problemDraftObjects).where(
    eq(problemDraftObjects.problem_id, "sp-p2"),
  );
  assertEquals(draftRows.length, 0);
});

Deno.test("support package: 未发布题目删除时清理迁移期投影", async () => {
  const provider = useTempStorage();
  await seedProblem("sp-p3", 940003);
  const bytes = new TextEncoder().encode("legacy-package");
  const url = await provider.put("spLegacy", bytes);
  await setSupportPackage("sp-p3", { storageUrl: url, byteSize: bytes.length });

  await deleteSupportPackage("sp-p3", "0", "admin");
  const [row] = await getDb().select().from(problems).where(
    eq(problems.id, "sp-p3"),
  );
  assertEquals(row.support_package_storage_url, null);
  assertEquals((await provider.stat(url)).exists, false);
  assertEquals(await resolveSupportPackageRef("sp-p3"), null);
});

Deno.test("support package: 模板优先从版本内容读取（不下载支持包）", async () => {
  const provider = useTempStorage();
  await seedProblem("sp-p4", 940004);
  const bytes = new TextEncoder().encode("package-with-old-template");
  const url = await provider.put("spTpl", bytes);
  await setSupportPackage("sp-p4", { storageUrl: url, byteSize: bytes.length });
  await saveProblemDraft("sp-p4", {
    content: aiContent("# 版本内模板\nprint(42)"),
    expectedRevision: 0,
  });
  await publishProblemVersion("sp-p4", { expectedRevision: 1 });

  const template = await resolveProblemTemplate({
    id: "sp-p4",
    number: 940004,
    title: "带包题目",
  }, { srcRoot: `${tempStorageDir}/no-such-src` });
  assertEquals(template?.content, "# 版本内模板\nprint(42)");
  assertEquals(template?.language, "python3");
});
