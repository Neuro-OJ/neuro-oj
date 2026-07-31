export type PostType = 'discussion' | 'solution' | 'moment';

export type PostStatus = 'draft' | 'pending' | 'published' | 'hidden' | 'deleted';

export interface CommunityConfig {
  enabled: boolean;
  guest_read_enabled: boolean;
  read_only: boolean;
  solutions_enabled: boolean;
  discussions_enabled: boolean;
  moments_enabled: boolean;
  activities_enabled: boolean;
  comments_enabled: boolean;
  reactions_enabled: boolean;
  bookmarks_enabled: boolean;
  follows_enabled: boolean;
  private_messaging_enabled: boolean;
  external_images_enabled: boolean;
  solution_requires_accepted: boolean;
  new_user_review_hours?: number;
  post_max_length?: number;
  moment_max_length?: number;
  comment_max_length?: number;
  permissions: Record<string, boolean>;
}

/** 社区帖子（来自后端完整行） */
export interface CommunityPost {
  id: string;
  type: PostType;
  title: string | null;
  content: string;
  status: PostStatus;
  is_locked: boolean;
  is_pinned: boolean;
  problem_id: string | null;
  board_id: string | null;
  author_id: string;
  moderation_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** 社区帖子列表行 */
export interface PostRow {
  post: CommunityPost;
  author: { id: string; username: string };
  likes: number;
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
  likes: number;
}

/** 个人收藏列表行 */
export interface BookmarkRow {
  post: CommunityPost;
  author: { id: string; username: string };
  bookmarked_at: string;
  likes: number;
  comments: number;
}

/** 各类型已发布帖子计数 */
export interface CommunityCounts {
  solution: number;
  discussion: number;
  moment: number;
}

/** 系统活动事件（动态流条目） */
export interface FeedActivity {
  id: string;
  type: 'first_accepted' | 'solution_published' | 'contest_joined';
  subject_type: string;
  subject_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** 动态流条目：短动态或系统活动 */
export interface FeedItem {
  kind: 'moment' | 'activity';
  post?: CommunityPost;
  activity?: FeedActivity;
  author: { id: string; username: string };
}

/** 社区通知行 */
export interface NotificationRow {
  notification: {
    id: string;
    type: 'reply' | 'like' | 'follow' | 'moderation';
    post_id: string | null;
    comment_id: string | null;
    read_at: string | null;
    created_at: string;
    data: { status?: string; reason?: string };
  };
  actor: { id: string; username: string } | null;
}

export function useCommunity() {
  const config = useState<CommunityConfig | null>('community:config', () => null);
  const loading = useState('community:config-loading', () => false);

  async function loadConfig(force = false) {
    if (config.value && !force) return config.value;
    loading.value = true;
    try {
      const response = await $fetch<{ data: CommunityConfig }>('/api/v1/community/config');
      config.value = response.data;
      return response.data;
    } finally {
      loading.value = false;
    }
  }

  return { config, loading, loadConfig };
}
