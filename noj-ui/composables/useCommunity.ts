import type { CommunityNotificationType } from '~/utils/communityNotifications';

export type PostType = 'discussion' | 'solution';

export type PostStatus = 'draft' | 'pending' | 'published' | 'hidden' | 'deleted';

export interface CommunityConfig {
  enabled: boolean;
  guest_read_enabled: boolean;
  read_only: boolean;
  solutions_enabled: boolean;
  discussions_enabled: boolean;
  comments_enabled: boolean;
  external_images_enabled: boolean;
  solution_requires_accepted: boolean;
  new_user_review_hours?: number;
  post_max_length?: number;
  comment_max_length?: number;
  post_interval_seconds?: number;
  permissions: Record<string, boolean>;
  /** 赛时社区全局静默：存在未结束公开赛且当前用户非审核员时为 true，写入入口应禁用。 */
  contest_silence?: boolean;
}

/** 社区帖子（来自后端完整行） */
export interface CommunityPost {
  id: string;
  public_id?: string;
  type: PostType;
  title: string | null;
  content: string;
  status: PostStatus;
  is_locked: boolean;
  is_pinned: boolean;
  /** 官方题解标记：由题目 owner 或审核员设置，题解列表置顶展示。 */
  is_official: boolean;
  problem_id: string | null;
  board_id: string | null;
  author_id: string;
  moderation_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** 社区举报（来自后端 community_reports 行，含关联信息） */
export interface ReportRow {
  report: {
    id: string;
    reporter_id: string;
    post_id: string | null;
    comment_id: string | null;
    assignment_id?: string | null;
    feedback_id?: string | null;
    help_id?: string | null;
    content_type: string;
    category: string;
    reason: string;
    content_snapshot: string;
    status: 'pending' | 'resolved' | 'dismissed';
    resolution: string | null;
    resolved_by: string | null;
    resolved_at: string | null;
    created_at: string;
    updated_at: string;
  };
  reporter: { id: string; username: string; avatar_url?: string | null };
  reported_author: { id: string; username: string } | null;
  resolved_by_user: { id: string; username: string } | null;
  active_sanction: boolean;
  ban: {
    id: string;
    scope: 'platform' | 'social';
    banned_until: string | null;
  } | null;
  post: {
    id: string;
    title: string | null;
    content: string;
    type: string;
    author_id: string;
  } | null;
  comment: {
    id: string;
    content: string;
    post_id: string;
    author_id: string;
  } | null;
  message: {
    id: string;
    content: string;
    type: string;
    conversation_id: string;
    sender_id: string;
  } | null;
}

/** 社区帖子列表行 */
export interface PostRow {
  post: CommunityPost;
  author: { id: string; username: string };
  comments: number;
}

/** 社区评论 */
export interface CommunityComment {
  id: string;
  post_id: string;
  author_id: string;
  parent_id: string | null;
  content: string;
  status: PostStatus;
  moderation_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** 评论列表行 */
export interface CommentRow {
  comment: CommunityComment;
  author: { id: string; username: string };
}

/** 各类型已发布帖子计数 */
export interface CommunityCounts {
  solution: number;
  discussion: number;
}

/** 社区通知行 */
export interface NotificationRow {
  domain?: { id: string; slug: string; name: string } | null;
  notification: {
    id: string;
    // 类型定义与展示/跳转规则共用 utils/communityNotifications.ts，避免两处漂移
    type: CommunityNotificationType;
    post_id: string | null;
    comment_id: string | null;
    assignment_id?: string | null;
    feedback_id?: string | null;
    help_id?: string | null;
    read_at: string | null;
    created_at: string;
    data: {
      status?: string;
      reason?: string;
      contest_id?: string;
      clarification_id?: string;
      problem_label?: string | null;
      is_public?: boolean;
      report_id?: string;
      scope?: string;
      banned_until?: string | null;
      banned_at?: string;
      message?: string;
      resolution?: string;
    };
  };
  actor: { id: string; username: string } | null;
}

export function useCommunity() {
  const scope = useCommunityScope();
  const { api } = useApi();
  const { data, status, refresh, error } = useAsyncData(
    computed(() => `${scope.key.value}:config`),
    async () => {
      const request = scope.capture();
      const response = await api.get<{ data: CommunityConfig }>(request.apiPath('config'), { silent: true });
      return { key: request.key, config: response.data };
    },
    { immediate: false },
  );
  const config = computed(() =>
    status.value !== 'error' && data.value?.key === scope.key.value ? data.value.config : null
  );
  const loading = computed(() => status.value === 'pending');

  async function loadConfig(force = false) {
    if (config.value && !force) return config.value;
    await refresh();
    // 配置不可用时隐藏入口，不能使用另一域或另一账号的旧权限。
    return status.value === 'error' ? null : config.value;
  }

  return { config, loading, loadConfig, error };
}
