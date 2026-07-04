/**
 * 全局封禁状态 composable（ban-status-endpoint）。
 *
 * 在应用布局级调用 fetch()，获取当前 IP 封禁 + 用户封禁状态，
 * 由 BanBanner 组件消费渲染全局覆盖层。
 *
 * 使用 useState 确保 SSR → 客户端水合过程只调一次。
 */

export interface IpBanInfo {
  matched_cidr: string;
  reason: string;
  expires_at: string | null;
  created_at: string;
}

export interface UserBanInfo {
  reason: string;
  until: string | null;
}

export interface BanStatusResponse {
  ip_banned: boolean;
  ip_ban_info: IpBanInfo | null;
  user_banned: boolean;
  user_ban_info: UserBanInfo | null;
  authenticated: boolean;
  user: { id: string; role: string } | null;
}

export function useBanStatus() {
  const ipBanned = useState<boolean>("ban:ipBanned", () => false);
  const userBanned = useState<boolean>("ban:userBanned", () => false);
  const ipBanInfo = useState<IpBanInfo | null>("ban:ipBanInfo", () => null);
  const userBanInfo = useState<UserBanInfo | null>("ban:userBanInfo", () => null);
  const authenticated = useState<boolean>("ban:authenticated", () => false);
  const user = useState<{ id: string; role: string } | null>("ban:user", () => null);
  const loading = useState<boolean>("ban:loading", () => true);
  const error = useState<string>("ban:error", () => "");

  let fetched = false;

  async function fetch(): Promise<BanStatusResponse | null> {
    if (fetched && import.meta.client) return null;
    loading.value = true;
    error.value = "";
    try {
      const res = await $fetch<BanStatusResponse>("/api/v1/auth/ban-status");
      ipBanned.value = res.ip_banned;
      ipBanInfo.value = res.ip_ban_info;
      userBanned.value = res.user_banned;
      userBanInfo.value = res.user_ban_info;
      authenticated.value = res.authenticated;
      user.value = res.user;
      fetched = true;
      return res;
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : "获取封禁状态失败";
      return null;
    } finally {
      loading.value = false;
    }
  }

  return {
    ipBanned,
    userBanned,
    ipBanInfo,
    userBanInfo,
    authenticated,
    user,
    loading,
    error,
    fetch,
  };
}
