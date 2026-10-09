import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { selfTests, submissions } from "../../../shared/db/schema.ts";
import { Channels, publishSseEvent } from "../../../shared/sse/event-bus.ts";
import { OI_VERDICTS } from "./submissions/oi-details.ts";

/** 安全的累计进度快照；不包含隐藏输入、答案或内部文件路径。 */
export interface OiProgress {
  sequence: number;
  phase: "queued" | "compiling" | "judging";
  total_cases: number;
  active_cases: { subtask_id: string; case_id: string }[];
  completed_cases: Record<string, unknown>[];
}

/** 在持久化前收窄 Worker 快照字段；自测流输出仅进入私有记录。 */
export function projectOiProgress(
  value: unknown,
  selfTest = false,
): OiProgress | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 1 ||
    !["queued", "compiling", "judging"].includes(raw.phase as string) ||
    !Number.isSafeInteger(raw.total_cases) || (raw.total_cases as number) < 0 ||
    (raw.total_cases as number) > 100 ||
    !Array.isArray(raw.active_cases) || !Array.isArray(raw.completed_cases)
  ) return null;
  const id = (item: unknown): item is { subtask_id: string; case_id: string } =>
    !!item && typeof item === "object" &&
    typeof (item as Record<string, unknown>).subtask_id === "string" &&
    /^[A-Za-z0-9_-]{1,100}$/.test(
      (item as Record<string, string>).subtask_id,
    ) &&
    typeof (item as Record<string, unknown>).case_id === "string" &&
    /^[A-Za-z0-9_-]{1,100}$/.test((item as Record<string, string>).case_id);
  const active = raw.active_cases.slice(0, 100).filter(id).map((item) => ({
    subtask_id: item.subtask_id,
    case_id: item.case_id,
  }));
  const completed = raw.completed_cases.slice(0, 100).filter(id).map((item) => {
    const src = item as unknown as Record<string, unknown>;
    const result: Record<string, unknown> = {
      subtask_id: item.subtask_id,
      case_id: item.case_id,
    };
    if (OI_VERDICTS.includes(src.status as typeof OI_VERDICTS[number])) {
      result.status = src.status;
    }
    for (const key of ["score", "max_score", "time_ms", "memory_kb"]) {
      if (
        typeof src[key] === "number" && Number.isFinite(src[key]) &&
        src[key] >= 0
      ) result[key] = src[key];
    }
    if (selfTest) {
      for (const stream of ["stdout", "stderr"]) {
        if (typeof src[stream] === "string") {
          result[stream] = src[stream].slice(0, 64 * 1024);
        }
        result[`${stream}_truncated`] = src[`${stream}_truncated`] === true;
      }
    }
    return result;
  });
  return {
    sequence: raw.sequence as number,
    phase: raw.phase as OiProgress["phase"],
    total_cases: raw.total_cases as number,
    active_cases: active,
    completed_cases: completed,
  };
}

/** 行锁保护尝试标识和序号；终态、过时轮次、乱序与重复快照均不覆盖。 */
export async function saveOiProgress(
  message: Record<string, unknown>,
): Promise<void> {
  const id = message.submission_id;
  if (typeof id !== "string" || typeof message.run_id !== "string") return;
  const selfTest = id.startsWith("st_");
  const progress = projectOiProgress(message.progress, selfTest);
  if (!progress) return;
  const db = getDb();
  const applied = await db.transaction(async (tx) => {
    if (selfTest) {
      const [row] = await tx.select().from(selfTests).where(
        eq(selfTests.id, id),
      ).for("update");
      if (
        !row || !["pending", "judging"].includes(row.status) ||
        row.judge_run_id !== message.run_id ||
        ((row.judge_progress as OiProgress | null)?.sequence ?? 0) >=
          progress.sequence
      ) return false;
      await tx.update(selfTests).set({ judge_progress: progress }).where(
        eq(selfTests.id, id),
      );
    } else {
      const [row] = await tx.select().from(submissions).where(
        eq(submissions.id, id),
      ).for("update");
      if (
        !row || !["pending", "judging"].includes(row.status) ||
        row.judge_run_id !== message.run_id ||
        row.rejudge_seq !== (message.rejudge_seq ?? 0) ||
        ((row.judge_progress as OiProgress | null)?.sequence ?? 0) >=
          progress.sequence
      ) return false;
      await tx.update(submissions).set({ judge_progress: progress }).where(
        and(
          eq(submissions.id, id),
          inArray(submissions.status, ["pending", "judging"]),
        ),
      );
    }
    return true;
  });
  if (applied) {
    await publishSseEvent(Channels.submission(id), {
      type: "submission:updated",
      id,
    });
  }
}
