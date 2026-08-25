/**
 * LLM 调用审计写入。
 */
import type { Db } from "./db.ts";

export interface UsageEntry {
  id: string;
  submission_id: string;
  problem_id: string;
  user_id: string;
  provider_id: string;
  model: string;
  request_messages: unknown;
  request_params: unknown;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  latency_ms: number;
  status: string;
  error_code?: string | null;
  prompt_hash: string;
  created_at: string;
}

/** 写入一条 LLM 用量审计记录；调用方负责在成功/失败/拒绝各分支调用。 */
export async function recordUsage(db: Db, entry: UsageEntry): Promise<void> {
  await db`
    INSERT INTO llm_usage (
      id, submission_id, problem_id, user_id, provider_id, model,
      request_messages, request_params, prompt_tokens, completion_tokens,
      total_tokens, estimated_cost, latency_ms, status, error_code,
      prompt_hash, created_at
    ) VALUES (
      ${entry.id}, ${entry.submission_id}, ${entry.problem_id}, ${entry.user_id},
      ${entry.provider_id}, ${entry.model}, ${
    JSON.stringify(entry.request_messages)
  },
      ${JSON.stringify(entry.request_params)}, ${entry.prompt_tokens},
      ${entry.completion_tokens}, ${entry.total_tokens}, ${entry.estimated_cost},
      ${entry.latency_ms}, ${entry.status}, ${entry.error_code ?? null},
      ${entry.prompt_hash}, ${entry.created_at}
    )
  `;
}
