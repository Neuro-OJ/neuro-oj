import { check, index, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

/**
 * 内容合规审核队列表（issue #413）。
 *
 * UGC（帖子/评论）同步审核与私信异步审核的"送审 → 机器判定 → 人工处置"
 * 全生命周期记录。既是审核留痕（approved/pass、rejected/block），也是
 * 统一人工审查队列（pending_review），管理员处理后在原行落 reviewed。
 *
 * 设计要点：
 * - 私信送审只传文本内容（content_snapshot），不传图片/附件地址
 * - content_snapshot 为送审原文快照，内容后续编辑/删除不影响审核追溯
 * - meta 存上下文（作者、会话双方、标题等），详情端点按 content_type 展开
 */
export const contentReviewQueue = pgTable(
  "content_review_queue",
  {
    id: text("id").primaryKey(),
    /** 目标内容类型：帖子 / 评论 / 私信消息 */
    content_type: text("content_type").notNull(),
    /** 目标内容主键（community_posts / community_comments / messages 的 UUID） */
    target_id: text("target_id").notNull(),
    /** 来源渠道：ugc = UGC 同步审核；dm = 私信异步审核队列 */
    channel: text("channel").notNull(),
    /**
     * 处理状态：
     * - pending_review：疑似/低置信/审核不可用，待人工复核
     * - approved：机器放行（留痕，不进人工队列视图）
     * - rejected：机器高置信拦截（同步审核时内容未发布，留痕）
     * - reviewed：管理员已人工处置
     * - dismissed：管理员驳回（认为无需处置）
     */
    status: text("status").notNull(),
    /** 实际判定 Provider：mock / aliyun / tencent / none（未运行或失败） */
    review_provider: text("review_provider").notNull(),
    /** 机器判定结论：pass / review（疑似转人工） / block / error（fail-open） */
    verdict: text("verdict").notNull(),
    /** 命中分类标签（JSON 数组字符串，如 ["政治","广告"]） */
    label: text("label"),
    /** 命中词（JSON 数组字符串，送审时按隐私要求记录） */
    hit_words: text("hit_words"),
    /** 风险级别：low / medium / high */
    risk_level: text("risk_level"),
    /** 送审内容快照（私信仅文本） */
    content_snapshot: text("content_snapshot").notNull().default(""),
    /** 上下文 JSON：作者/会话/标题等，详情端点据此展开 */
    meta: text("meta").notNull().default("{}"),
    /** 人工处置人（无 RequestContext 时可为空） */
    reviewed_by: text("reviewed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** 人工处置时间 */
    reviewed_at: text("reviewed_at"),
    /** 人工处置说明 */
    resolution: text("resolution"),
    /** 处置动作（留痕）：record_only / hide_post / hide_comment / ban / dismiss 等 */
    action_taken: text("action_taken"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    contentTypeCheck: check(
      "content_review_queue_content_type_check",
      sql`${table.content_type} IN ('post', 'comment', 'message')`,
    ),
    channelCheck: check(
      "content_review_queue_channel_check",
      sql`${table.channel} IN ('ugc', 'dm')`,
    ),
    statusCheck: check(
      "content_review_queue_status_check",
      sql`${table.status} IN ('pending_review', 'approved', 'rejected', 'reviewed', 'dismissed')`,
    ),
    verdictCheck: check(
      "content_review_queue_verdict_check",
      sql`${table.verdict} IN ('pass', 'review', 'block', 'error')`,
    ),
    pendingStatusIdx: index("idx_content_review_queue_pending_status").on(
      table.status,
      table.created_at,
    ),
    typeStatusIdx: index("idx_content_review_queue_type_status").on(
      table.content_type,
      table.status,
    ),
    targetIdx: index("idx_content_review_queue_target").on(table.target_id),
  }),
);
