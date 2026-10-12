import type { Executor } from "./db/executor.ts";
import { educationOutbox } from "./db/schema.ts";

/** 生产者只登记事实定位，消费者从数据库读取最新结果，不信任事件里的成绩。 */
export interface EducationEvent {
  domain_id: string;
  event_type:
    | "submission.changed"
    | "problem.changed"
    | "recipient.changed"
    | "assignment.published"
    | "module.changed";
  user_id?: string;
  problem_id?: string;
  classroom_id?: string;
  assignment_id?: string;
  payload?: Record<string, unknown>;
}

/** 必须传入业务事务，保证事实写入与教学事件共同提交或回滚。 */
export async function recordEducationEvent(
  executor: Executor,
  event: EducationEvent,
) {
  const now = new Date().toISOString();
  await executor.insert(educationOutbox).values({
    id: crypto.randomUUID(),
    ...event,
    created_at: now,
    available_at: now,
  });
}
