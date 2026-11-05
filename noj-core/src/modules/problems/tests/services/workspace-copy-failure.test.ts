/**
 * 跨域复制失败路径：失权、源身份变化与文件补偿。
 *
 * 复制分两段：锁外准备（读取源版本并上传文件）与锁内提交（重查权限、复核
 * 源身份并原子发布）。两段之间可能发生失权或源题被替换，此时必须
 * 1) 抛错且不留下半发布身份；2) 删除本次上传、且仅删除本次上传的对象。
 *
 * 关于「补偿」的可观测性：local/S3 存储是**内容寻址**的（URL 只由内容 SHA-256
 * 决定，上传 key 被忽略）。副本与源题内容逐字节相同，因此副本上传会被去重到
 * 源对象 URL；`compensateUploadedObject` 的引用守卫会保留仍被源版本引用的对象，
 * 此时补偿是 no-op。删除语义因此由「唯一字节」用例（源身份变化）覆盖；
 * `problem-bindings.ts` 的 try/catch 是面向非去重后端的保护。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  ConflictError,
  ForbiddenError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domainProblemBindings,
  problems,
} from "../../../../shared/db/schema.ts";
import { assignmentFixture } from "../../../education/tests/_assignment-fixture.ts";
import { setMemberRole } from "../../../access/workspace/index.ts";
import {
  getStorageObject,
  uploadStorageObjectWithReservation,
} from "../../../assets/contracts/cross-module/services_registry.ts";
import { getStorageProvider } from "../../../assets/storage/mod.ts";
import {
  commitDomainProblemCopy,
  compensateProblemCopy,
  prepareDomainProblemCopy,
  type PreparedProblemCopy,
} from "../../services/workspace/problem-copy.ts";

async function targetProblems(domainId: string) {
  return await getDb().select().from(problems).where(
    eq(problems.domain_id, domainId),
  );
}

Deno.test("域复制失败：prepare 后撤销目标域发布权限，提交被拒且不产生副本", async () => {
  const f = await assignmentFixture();
  // 教师在学校是教学人员（可导出源题），先授予另一学校的教学人员角色。
  await setMemberRole(f.other.slug, f.owner, f.teacher, "educator");
  const prepared = await prepareDomainProblemCopy(
    f.other.slug,
    `${f.school.slug}:1001`,
    f.teacher,
  );
  // 准备与提交之间被降为普通成员：提交阶段必须重查权限而不是信任预检。
  await setMemberRole(f.other.slug, f.owner, f.teacher, "member");
  await assertRejects(
    () => getDb().transaction((tx) => commitDomainProblemCopy(tx, prepared)),
    ForbiddenError,
  );
  await compensateProblemCopy(prepared);
  assertEquals((await targetProblems(f.other.id)).length, 0);
  assertEquals(
    (await f.db.select().from(domainProblemBindings).where(
      eq(domainProblemBindings.domain_id, f.other.id),
    )).length,
    0,
  );
});

Deno.test("域复制失败：源题身份变化抛 409，并补偿删除本次上传对象", async () => {
  const f = await assignmentFixture();
  const prepared = await prepareDomainProblemCopy(
    f.other.slug,
    `${f.school.slug}:1001`,
    f.owner,
  );
  // 唯一字节：避免内容寻址去重命中已有对象，确保补偿删除可观测。
  const uploaded = await uploadStorageObjectWithReservation({
    key: `domain-copy-failure-${crypto.randomUUID()}`,
    bytes: new TextEncoder().encode("package-bytes"),
    contentType: "application/octet-stream",
    domainId: f.other.id,
  });
  const changed: PreparedProblemCopy = {
    ...prepared,
    // 模拟源题被删除后同题号重建：id 与准备阶段不一致。
    sourceId: crypto.randomUUID(),
    objects: [{
      role: "support_package",
      path: "package.zip",
      storage_url: uploaded.storageUrl,
      sha256: "deadbeef",
      size: 13,
    }],
  };
  await assertRejects(
    () => getDb().transaction((tx) => commitDomainProblemCopy(tx, changed)),
    ConflictError,
    "源题身份已变化",
  );
  await compensateProblemCopy(changed);
  const provider = await getStorageProvider();
  assertEquals((await provider.stat(uploaded.storageUrl)).exists, false);
  assertEquals((await getStorageObject(uploaded.storageUrl))?.state, "deleted");
  assertEquals((await targetProblems(f.other.id)).length, 0);
});
