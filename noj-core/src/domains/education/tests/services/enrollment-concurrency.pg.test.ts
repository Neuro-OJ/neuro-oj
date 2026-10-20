import { assertEquals } from "jsr:@std/assert@^1";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import { unwrapRows } from "../../../../shared/base/sql-rows.ts";
import * as schema from "../../../../shared/db/schema.ts";
import { workspaceAudit } from "../../../workspace/index.ts";
import { executeClassroomImport, previewClassroomImport } from "../../index.ts";
import { educationFixture } from "../_fixtures.ts";

function connection() {
  return postgres(Deno.env.get("DATABASE_URL")!, {
    max: 1,
    onnotice: () => {},
  });
}
Deno.test({
  name:
    "批量入班并发 PG：等待域锁时保留账号保护，但不阻止持班级锁的教师写审计外键",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await educationFixture(), csv = `username\n${f.student}`;
    const preview = await previewClassroomImport(
      f.school.slug,
      f.classroom.id,
      f.teacher,
      csv,
    );
    const [business] = unwrapRows<{ pid: number }>(
      await f.db.execute(sql`SELECT pg_backend_pid() AS pid`) as never,
    );
    const holder = connection(), observer = connection();
    let signalHeld!: (pid: number) => void, release!: () => void;
    const held = new Promise<number>((resolve) => {
      signalHeld = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = drizzle(holder, { schema }).transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM domains WHERE id = ${f.school.id} FOR SHARE`,
      );
      await tx.execute(
        sql`SELECT id FROM classrooms WHERE id = ${f.classroom.id} FOR UPDATE`,
      );
      const [row] = unwrapRows<{ pid: number }>(
        await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as never,
      );
      signalHeld(row.pid);
      await resume;
      await workspaceAudit(
        tx,
        f.teacher,
        f.school.id,
        "domain.update",
        { operation: "classroom.concurrent.read-contract" },
      );
    });
    let importing: Promise<unknown> | undefined;
    try {
      const holderPid = await held;
      importing = executeClassroomImport(
        f.school.slug,
        f.classroom.id,
        f.teacher,
        "concurrent",
        0,
        { csv, preview_hash: preview.preview_hash },
      );
      let blocked = false;
      for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
        const [row] =
          await observer`SELECT ${holderPid}::int = ANY(pg_blocking_pids(${business.pid}::int)) AS blocked`;
        blocked = row.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assertEquals(blocked, true);
      release();
      await writing;
      const result = await importing as { summary: { join: number } };
      assertEquals(result.summary.join, 1);
    } finally {
      release();
      await Promise.allSettled([writing, ...(importing ? [importing] : [])]);
      await Promise.all([holder.end(), observer.end()]);
      await resetDbForTest();
    }
  },
});
