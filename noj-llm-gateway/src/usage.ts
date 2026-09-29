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
  cached_prompt_tokens?: number;
  billed_prompt_tokens?: number;
  billed_total_tokens?: number;
  estimated_cost: number;
  latency_ms: number;
  status: string;
  error_code?: string | null;
  prompt_hash: string;
  created_at: string;
}

/** 限制单条审计记录中 request_messages 大小，避免超大包塞爆 DB（GW-03）。 */
const MAX_STORED_MESSAGES_BYTES = 64 * 1024;

function sanitizeMessagesForStorage(messages: unknown): unknown {
  try {
    const serialized = JSON.stringify(messages);
    if (serialized.length <= MAX_STORED_MESSAGES_BYTES) {
      return messages;
    }
    return [
      {
        role: "system",
        content:
          `[messages_truncated: original size ${serialized.length} bytes exceeded 64KB limit]`,
      },
    ];
  } catch {
    return [];
  }
}

/** 写入一条 LLM 用量审计记录；调用方负责在成功/失败/拒绝各分支调用。 */
export async function recordUsage(db: Db, entry: UsageEntry): Promise<void> {
  const safeMessages = sanitizeMessagesForStorage(entry.request_messages);
  await db`
    INSERT INTO llm_usage (
      id, submission_id, problem_id, user_id, provider_id, model,
      request_messages, request_params, prompt_tokens, completion_tokens,
      total_tokens, cached_prompt_tokens, billed_prompt_tokens,
      billed_total_tokens, estimated_cost, latency_ms, status, error_code,
      prompt_hash, created_at
    ) VALUES (
      ${entry.id}, ${entry.submission_id}, ${entry.problem_id}, ${entry.user_id},
      ${entry.provider_id}, ${entry.model}, ${JSON.stringify(safeMessages)},
      ${JSON.stringify(entry.request_params)}, ${entry.prompt_tokens},
      ${entry.completion_tokens}, ${entry.total_tokens},
      ${entry.cached_prompt_tokens ?? 0}, ${entry.billed_prompt_tokens ?? 0},
      ${entry.billed_total_tokens ?? 0}, ${entry.estimated_cost},
      ${entry.latency_ms}, ${entry.status}, ${entry.error_code ?? null},
      ${entry.prompt_hash}, ${entry.created_at}
    )
  `;
}
