/**
 * 全局封禁状态 composable（ban-status-endpoint）。
 *
 * 在应用布局级调用 fetch()，获取当前 IP 封禁 + 用户封禁状态，
 * 由 BanBanner 组件消费渲染全局覆盖层。
 *
 * 使用 useState 确保 SSR → 客户端水合过程只调一次。
 */
import { extractApiError } from '~/utils/apiError';

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
  const { api } = useApi();
  const ipBanned = useState<boolean>('ban:ip-banned', () => false);
  const userBanned = useState<boolean>('ban:user-banned', () => false);
  const ipBanInfo = useState<IpBanInfo | null>('ban:ip-ban-info', () => null);
  const userBanInfo = useState<UserBanInfo | null>('ban:user-ban-info', () => null);
  const authenticated = useState<boolean>('ban:authenticated', () => false);
  const user = useState<{ id: string; role: string } | null>('ban:user', () => null);
  const loading = useState<boolean>('ban:loading', () => true);
  const error = useState<string>('ban:error', () => '');

  let fetched = false;

  async function fetch(): Promise<BanStatusResponse | null> {
    // 客户端每次调用都重新请求，避免 SSR 填充的封禁状态在解封/封禁后不刷新
    if (fetched && import.meta.server) return null;
    loading.value = true;
    error.value = '';
    try {
      // 封禁状态为全局静默请求：失败由 BanBanner 依据 error state 处理，不弹 toast。
      // 该端点允许匿名访问；即便代理短暂返回 401，也不能把首页访客跳转到登录页。
      const res = await api.get<BanStatusResponse>(
        '/api/v1/auth/ban-status',
        { silent: true, redirectOnUnauthorized: false },
      );
      ipBanned.value = res.ip_banned;
      ipBanInfo.value = res.ip_ban_info;
      userBanned.value = res.user_banned;
      userBanInfo.value = res.user_ban_info;
      authenticated.value = res.authenticated;
      user.value = res.user;
      fetched = true;
      return res;
    } catch (err: unknown) {
      error.value = extractApiError(err).message;
      return null;
    } finally {
      loading.value = false;
    }
  }

  // 仅暴露消费方实际使用的状态；authenticated/user/loading/error 为内部状态
  return {
    ipBanned,
    userBanned,
    ipBanInfo,
    userBanInfo,
    fetch,
  };
}
