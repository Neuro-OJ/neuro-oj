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
  /**
   * 获取会话列表。
   */
  async function fetchConversations(page = 1, perPage = 20) {
    return $fetch<{
      data: Conversation[];
      pagination: Pagination;
    }>(`/api/v1/conversations?page=${page}&per_page=${perPage}`);
  }

  /**
   * 查找或创建会话。
   */
  async function findOrCreateConversation(otherUserId: string) {
    return $fetch<{ data: Conversation }>("/api/v1/conversations", {
      method: "POST",
      body: { other_user_id: otherUserId },
    });
  }

  /**
   * 获取消息列表。
   */
  async function fetchMessages(conversationId: string, page = 1, perPage = 50) {
    return $fetch<{
      data: ConversationMessage[];
      pagination: Pagination;
    }>(`/api/v1/conversations/${conversationId}/messages?page=${page}&per_page=${perPage}`);
  }

  /**
   * 发送消息。
   */
  async function sendMessage(conversationId: string, content: string) {
    return $fetch<{ data: ConversationMessage }>(
      `/api/v1/conversations/${conversationId}/messages`,
      {
        method: "POST",
        body: { content },
      },
    );
  }

  /**
   * 标记已读。
   */
  async function markRead(conversationId: string, lastReadMessageId: string) {
    return $fetch(`/api/v1/conversations/${conversationId}/read`, {
      method: "POST",
      body: { last_read_message_id: lastReadMessageId },
    });
  }

  /**
   * 获取未读消息总数（用于导航栏徽标）。
   */
  async function fetchUnreadCount(): Promise<number> {
    const res = await $fetch<{ unread_count: number }>(
      "/api/v1/conversations/unread-count",
    );
    return res.unread_count;
  }

  /**
   * 获取单会话未读数。
   */
  async function fetchUnreadCountByConversation(
    conversationId: string,
  ): Promise<number> {
    const res = await $fetch<{ unread_count: number }>(
      `/api/v1/conversations/${conversationId}/unread-count`,
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
