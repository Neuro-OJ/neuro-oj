import { DEFAULT_LOCALE, type Locale, LOCALE_COOKIE, normalizeLocale, translate } from '~/utils/i18n';

/**
 * SSR 安全的语言状态。
 * Cookie 是唯一持久化来源，避免 localStorage 只在客户端可用而造成首屏闪烁。
 */
export function useI18n() {
  const localeCookie = useCookie<Locale>(LOCALE_COOKIE, {
    default: () => DEFAULT_LOCALE,
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
  const locale = useState<Locale>('noj:locale', () => normalizeLocale(localeCookie.value));

  // 处理用户手动清理/修改 cookie 的情况，同时不在 SSR 改写响应状态。
  if (import.meta.server && locale.value !== normalizeLocale(localeCookie.value)) {
    locale.value = normalizeLocale(localeCookie.value);
  }

  const setLocale = (next: Locale) => {
    const normalized = normalizeLocale(next);
    locale.value = normalized;
    localeCookie.value = normalized;
    if (import.meta.client) {
      document.documentElement.lang = normalized;
    }
  };

  const t = (key: string, params?: Record<string, string | number>) => translate(locale.value, key, params);

  return {
    locale,
    t,
    setLocale,
    isEnglish: computed(() => locale.value === 'en-US'),
    localeOptions: [
      { label: '中文', value: 'zh-CN' as Locale },
      { label: 'English', value: 'en-US' as Locale },
    ],
  };
}
