export interface Conversation {
  id: string;
  other_user_id: string;
  other_user_name: string;
  last_message_preview: string;
  last_message_at: string;
  unread_count: number;
  /** 用户设置的备注名（null = 显示真实用户名） */
  remark_name: string | null;
  /** 消息免打扰：开启后新消息仅显示红点不显示数量 */
  is_muted: boolean;
  created_at: string;
}

export interface ReactionUser {
  id: string;
  username: string;
  avatar_url: string | null;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  reacted_by_me: boolean;
  /** 操作人列表（用于显示头像） */
  users: ReactionUser[];
}

export interface ReplyToInfo {
  message_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  type: 'text' | 'image';
}

export interface ForwardedFromUser {
  id: string;
  username: string;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  type: 'text' | 'image';
  image_url: string | null;
  content: string;
  created_at: string;
  reply_to: ReplyToInfo | null;
  forwarded_from_user: ForwardedFromUser | null;
  reactions: MessageReaction[];
  /** 自己发送的消息：对方是否已读（null 表示非自己发送） */
  read: boolean | null;
  /** 编辑时间（null 表示未编辑） */
  edited_at: string | null;
  /** 撤回时间（null 表示未撤回） */
  recalled_at: string | null;
}

export interface Pagination {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

/** 常用 Reaction emoji 集合（与后端 REACTION_EMOJIS 保持一致） */
export const REACTION_EMOJIS = [
  '👍',
  '❤️',
  '😂',
  '😮',
  '😢',
  '🙏',
  '🎉',
  '🔥',
  '👏',
  '😍',
  '🤔',
  '😅',
  '💯',
  '👀',
  '😭',
  '🤯',
  '🥳',
  '😎',
  '🤝',
  '💪',
] as const;

/**
 * 私信功能 composable。
 *
 * 提供私信相关的 API 封装函数，不建立 SSE 连接。
 * SSE 由 /messages 页面级 useEventSource 管理。
 * 导航栏未读数通过定时轮询 fetchUnreadCount 获取。
 */
export function useMessages() {
  // 未读数查询（轮询/角标场景）内部静默：失败不影响主流程，不打扰用户
  const { api } = useApi();

  /**
   * 获取会话列表。
   */
  function fetchConversations(page = 1, perPage = 20) {
    return api.get<{
      data: Conversation[];
      pagination: Pagination;
    }>(`/api/v1/conversations?page=${page}&per_page=${perPage}`);
  }

  /**
   * 查找或创建会话。
   */
  function findOrCreateConversation(otherUserId: string) {
    return api.post<{ data: Conversation }>('/api/v1/conversations', {
      other_user_id: otherUserId,
    });
  }

  /**
   * 获取消息列表。
   */
  function fetchMessages(conversationId: string, page = 1, perPage = 50) {
    return api.get<{
      data: ConversationMessage[];
      pagination: Pagination;
    }>(
      `/api/v1/conversations/${conversationId}/messages?page=${page}&per_page=${perPage}`,
    );
  }

  /**
   * 发送文本消息（支持引用回复与转发）。
   */
  function sendMessage(
    conversationId: string,
    content: string,
    opts: {
      reply_to_message_id?: string;
      forwarded_from_message_id?: string;
    } = {},
  ) {
    return api.post<{ data: ConversationMessage }>(
      `/api/v1/conversations/${conversationId}/messages`,
      {
        content,
        ...(opts.reply_to_message_id ? { reply_to_message_id: opts.reply_to_message_id } : {}),
        ...(opts.forwarded_from_message_id ? { forwarded_from_message_id: opts.forwarded_from_message_id } : {}),
      },
    );
  }

  /**
   * 上传图片并发送图片消息。
   * 先 multipart 上传拿 image_url，再发 type=image 消息。
   */
  async function sendImage(
    conversationId: string,
    file: File,
    opts: {
      reply_to_message_id?: string;
      forwarded_from_message_id?: string;
    } = {},
  ) {
    const fd = new FormData();
    fd.append('file', file);
    const uploadRes = await api.post<{ data: { image_url: string } }>(
      `/api/v1/conversations/${conversationId}/messages/images`,
      fd,
    );
    return api.post<{ data: ConversationMessage }>(
      `/api/v1/conversations/${conversationId}/messages`,
      {
        type: 'image',
        image_url: uploadRes.data.image_url,
        ...(opts.reply_to_message_id ? { reply_to_message_id: opts.reply_to_message_id } : {}),
        ...(opts.forwarded_from_message_id ? { forwarded_from_message_id: opts.forwarded_from_message_id } : {}),
      },
    );
  }

  /**
   * 添加/替换消息 Reaction。
   */
  function addReaction(conversationId: string, messageId: string, emoji: string) {
    return api.post(
      `/api/v1/conversations/${conversationId}/messages/${messageId}/reactions`,
      { emoji },
    );
  }

  /**
   * 取消消息 Reaction。
   */
  function removeReaction(conversationId: string, messageId: string, emoji: string) {
    return api.delete(
      `/api/v1/conversations/${conversationId}/messages/${messageId}/reactions`,
      { body: { emoji } },
    );
  }

  /**
   * 标记已读。
   */
  function markRead(conversationId: string, lastReadMessageId: string) {
    return api.post(`/api/v1/conversations/${conversationId}/read`, {
      last_read_message_id: lastReadMessageId,
    });
  }

  /**
   * 获取未读消息总数（用于导航栏徽标）。
   * 静默模式：失败不弹 toast，但异常会向上抛出。
   */
  async function fetchUnreadCount(): Promise<number> {
    const res = await api.get<{ unread_count: number }>(
      '/api/v1/conversations/unread-count',
      { silent: true },
    );
    return res.unread_count;
  }

  /**
   * 获取单会话未读数。
   * 静默模式：失败不弹 toast，但异常会向上抛出。
   */
  async function fetchUnreadCountByConversation(
    conversationId: string,
  ): Promise<number> {
    const res = await api.get<{ unread_count: number }>(
      `/api/v1/conversations/${conversationId}/unread-count`,
      { silent: true },
    );
    return res.unread_count;
  }

  /**
   * 编辑消息（仅发送者本人，5 分钟内）。
   */
  function editMessage(conversationId: string, messageId: string, content: string) {
    return api.patch<{ data: { id: string; content: string } }>(
      `/api/v1/conversations/${conversationId}/messages/${messageId}`,
      { content },
    );
  }

  /**
   * 撤回消息（仅发送者本人，2 分钟内）。
   */
  function recallMessage(conversationId: string, messageId: string) {
    return api.post<{ data: { id: string } }>(
      `/api/v1/conversations/${conversationId}/messages/${messageId}/recall`,
    );
  }

  /**
   * 删除消息（仅当前用户视角）。
   */
  function deleteMessage(conversationId: string, messageId: string) {
    return api.delete(
      `/api/v1/conversations/${conversationId}/messages/${messageId}`,
    );
  }

  /**
   * 设置会话备注名（仅当前用户视角，空字符串清除）。
   */
  function setRemark(conversationId: string, remarkName: string) {
    return api.put<{ data: { conversation_id: string; remark_name: string | null } }>(
      `/api/v1/conversations/${conversationId}/remark`,
      { remark_name: remarkName },
    );
  }

  /**
   * 设置会话消息免打扰（仅当前用户视角）。
   */
  function setMuted(conversationId: string, isMuted: boolean) {
    return api.put<{ data: { conversation_id: string; is_muted: boolean } }>(
      `/api/v1/conversations/${conversationId}/mute`,
      { is_muted: isMuted },
    );
  }

  /**
   * 清空聊天记录（仅对当前用户隐藏，不实际删除消息）。
   */
  function clearMessages(conversationId: string) {
    return api.post<{ data: { conversation_id: string; cleared: number } }>(
      `/api/v1/conversations/${conversationId}/clear`,
    );
  }

  return {
    fetchConversations,
    findOrCreateConversation,
    fetchMessages,
    sendMessage,
    sendImage,
    addReaction,
    removeReaction,
    markRead,
    fetchUnreadCount,
    fetchUnreadCountByConversation,
    editMessage,
    recallMessage,
    deleteMessage,
    setRemark,
    setMuted,
    clearMessages,
  };
}
