/** 重测任务（rejudge）的载荷规范化与哈希：受理幂等键与重试幂等身份使用。 */

import { canonicalJson } from "../../../problems/types/problem-content.ts";
import type { JobSourceKind, RejudgeRequest } from "./rejudge-types.ts";

/** 规范化载荷的 SHA-256（相同语义请求必须得到相同哈希）。 */
export async function hashCanonical(value: unknown): Promise<string> {
  const payload = canonicalJson(value);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** 请求规范化哈希（相同请求必须得到相同哈希）。 */
export async function hashRequest(request: RejudgeRequest): Promise<string> {
  const payload = canonicalJson({
    kind: request.kind,
    scope: request.scope,
    target: request.target,
    policy_changes: (request.policy_changes ?? []).map((change) => ({
      problem_id: change.problem_id,
      contest_id: change.contest_id ?? null,
      expected_revision: change.expected_revision,
      policy: change.policy,
    })),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * 重试任务的幂等身份（#40）。
 *
 * 必须覆盖**父任务类型 + 父任务 ID + 规范化重试条目 + 固定目标版本映射**：
 * 只哈希 `retry_of` 无法区分条目集合已经变化的重试，也无法区分不同 kind 的父任务；
 * 不同父任务复用同一 Idempotency-Key 必须 409，不能错误返回同一个重试任务。
 */
export async function hashRetryRequest(
  parentKind: string,
  parentJobId: string,
  items: ReadonlyArray<{
    ordinal: number;
    source_kind: JobSourceKind;
    source_id: string;
    target_version_id: string | null;
    target_version_ref: string | null;
  }>,
): Promise<string> {
  return await hashCanonical({
    kind: "rejudge_retry",
    parent_kind: parentKind,
    parent_job_id: parentJobId,
    items: [...items].sort((a, b) => a.ordinal - b.ordinal).map((item) => ({
      ordinal: item.ordinal,
      source_kind: item.source_kind,
      source_id: item.source_id,
      target_version_id: item.target_version_id,
      target_version_ref: item.target_version_ref,
    })),
  });
}
