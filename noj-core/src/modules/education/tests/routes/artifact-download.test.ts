import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { zipSync } from "fflate";
import { createApp } from "../../../../app.ts";
import {
  domainProblemBindings,
  submissions,
} from "../../../../shared/db/schema.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { signToken } from "../../../access/identity/index.ts";
import { getStorageProvider } from "../../../assets/storage/mod.ts";
import { removeDomainMember } from "../../../access/workspace/index.ts";
import { setClassroomMember } from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test({
  name: "产物下载：当前班级授权、源题撤销、离域本人保留与教师撤权即时拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await assignmentFixture(), id = crypto.randomUUID();
    await initRedisForTest();
    const archive = zipSync({
      "student.txt": new TextEncoder().encode("my submitted artifact"),
    });
    const storage = await getStorageProvider(),
      url = await storage.put(`artifact-${id}`, archive, "application/zip");
    try {
      await f.db.insert(submissions).values({
        id,
        domain_id: f.school.id,
        domain_problem_binding_id: f.bindingId,
        user_id: f.student,
        problem_id: f.problemId,
        language: "artifact",
        code: "",
        file_name: "作答文件.zip",
        artifact_storage_url: url,
        submitted_version_id: f.versionId,
        version_origin: "known",
        created_at: new Date().toISOString(),
      });
      await setClassroomMember(
        f.school.slug,
        f.classroom.id,
        f.teacher,
        f.assistant,
        1,
        { role: "student" },
      );
      const teacher = await signToken({ sub: f.teacher, role: "user" }),
        student = await signToken({ sub: f.student, role: "user" }),
        assistant = await signToken({ sub: f.assistant, role: "user" });
      const app = createApp(),
        base =
          `/api/v1/domains/${f.school.slug}/classrooms/${f.classroom.id}/submissions/submission/${id}/artifact`,
        own = `/api/v1/me/submissions/submission/${id}/artifact`;
      assertEquals((await jsonRequest(app, base)).status, 401);
      assertEquals(
        (await jsonRequest(app, base, { token: assistant })).status,
        404,
      );
      assertEquals(
        (await jsonRequest(app, own, { token: teacher })).status,
        404,
      );
      const downloaded = await jsonRequest(app, base, { token: teacher });
      assertEquals(downloaded.status, 200);
      assertEquals(
        downloaded.headers.get("Cache-Control"),
        "private, no-store",
      );
      assertEquals(downloaded.headers.get("Content-Type"), "application/zip");
      assertEquals(
        downloaded.headers.get("Content-Length"),
        String(archive.length),
      );
      assertEquals(
        downloaded.headers.get("Content-Disposition"),
        `attachment; filename*=UTF-8''${encodeURIComponent("作答文件.zip")}`,
      );
      assertEquals(downloaded.headers.get("Location"), null);
      assertEquals(new Uint8Array(await downloaded.arrayBuffer()), archive);
      await f.db.update(domainProblemBindings).set({
        disabled_at: new Date().toISOString(),
      }).where(eq(domainProblemBindings.id, f.bindingId));
      const retained = await jsonRequest(app, base, { token: student });
      assertEquals(retained.status, 200);
      assertEquals(new Uint8Array(await retained.arrayBuffer()), archive);
      await removeDomainMember(f.school.slug, f.owner, f.teacher);
      assertEquals(
        (await jsonRequest(app, base, { token: teacher })).status,
        404,
      );
      await removeDomainMember(f.school.slug, f.owner, f.student);
      assertEquals(
        (await jsonRequest(app, base, { token: student })).status,
        404,
      );
      const ownDownload = await jsonRequest(app, own, { token: student });
      assertEquals(ownDownload.status, 200);
      assertEquals(new Uint8Array(await ownDownload.arrayBuffer()), archive);
      const history = await jsonRequest(
        app,
        `/api/v1/me/submissions/submission/${id}`,
        { token: student },
      );
      assertEquals((await history.json()).data.has_artifact, true);
      await storage.delete(url);
      assertEquals(
        (await jsonRequest(app, own, { token: student })).status,
        404,
      );
    } finally {
      await storage.delete(url);
    }
  },
});
