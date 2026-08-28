export interface Conversation {
  id: string;
  other_user_id: string;
  other_user_name: string;
  last_message_preview: string;
  last_message_at: string;
  unread_count: number;
  created_at: string;
}

export interface ConversationMessage {
  id: string;
  sender_id: string;
  content: string;
  created_at: string;
}

export interface Pagination {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

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
    return api.post<{ data: Conversation }>("/api/v1/conversations", {
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
   * 发送消息。
   */
  function sendMessage(conversationId: string, content: string) {
    return api.post<{ data: ConversationMessage }>(
      `/api/v1/conversations/${conversationId}/messages`,
      { content },
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
      "/api/v1/conversations/unread-count",
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

  return {
    fetchConversations,
    findOrCreateConversation,
    fetchMessages,
    sendMessage,
    markRead,
    fetchUnreadCount,
    fetchUnreadCountByConversation,
  };
}
