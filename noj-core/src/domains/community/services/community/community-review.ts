import {
  getReviewConfig,
  runContentReview,
} from "../../../content-review/index.ts";
import { ForbiddenError } from "../../../../lib/errors.ts";

/**
 * UGC（帖子/评论）同步内容合规审核钩子（issue #413）。
 *
 * 在 createPost/updatePost/createComment/updateComment 落库前调用：
 * - 高置信违规（block）→ 抛 ForbiddenError(CONTENT_REVIEW_REJECTED)，拒绝发布
 * - 疑似/低置信（review）→ 放行发布，记录进统一人工审查队列
 * - 机器放行（pass）→ 落 approved 留痕
 * - Provider 不可用/超时 → fail-open：放行发布 + 转人工待审
 *
 * 规则约定：
 * - 审核员/管理员（moderator=true）内容直接放行（沿用既有豁免模式）
 * - 内容最终为 pending（新用户审核期等既有规则已拦截）时不重复云审核，
 *   由既有待审队列统一人工放行，避免双队列互相干扰
 */

export interface UgcReviewInput {
  content_type: "post" | "comment";
  /** 落库前的目标 ID（block 时内容不会落库，仍记录快照留痕） */
  target_id: string;
  title?: string;
  content: string;
  /** 作者 UUID（上下文 meta，供人工队列查看） */
  author_id: string;
  /** 是否审核员/管理员操作（true 时跳过云审核） */
  moderator?: boolean;
  /** 内容最终可见状态：仅 published 才需要同步拦截 */
  finalStatus?: "published" | "pending";
}

/**
 * 执行 UGC 同步审核；高置信违规（且内容会公开）时抛错阻断发布。
 * @throws {ForbiddenError} 高置信违规（code=CONTENT_REVIEW_REJECTED，meta 带 label）
 */
export async function reviewUgcContent(
  input: UgcReviewInput,
): Promise<void> {
  // 总开关关闭 / 审核员操作 / 内容不会公开（已有 pending 人工队列）→ 直接放行
  if (
    input.moderator ||
    input.finalStatus !== "published" ||
    !getReviewConfig().enabled
  ) {
    return;
  }

  const text = input.title ? `${input.title}\n${input.content}` : input.content;

  const outcome = await runContentReview({
    content_type: input.content_type,
    target_id: input.target_id,
    channel: "ugc",
    text,
    enabled: true,
    meta: {
      author_id: input.author_id,
      title: input.title ?? "",
    },
  });

  if (outcome.action === "block") {
    throw new ForbiddenError(
      "内容疑似违规，已拦截发布；请修改后重试",
      "CONTENT_REVIEW_REJECTED",
      { label: outcome.label, risk_level: outcome.riskLevel },
    );
  }
  // review → 已放行并转人工；pass → 已留痕。均不阻断。
}
