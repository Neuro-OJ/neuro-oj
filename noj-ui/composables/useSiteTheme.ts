import { DEFAULT_SITE_THEME, normalizeSiteTheme, SITE_THEME_COOKIE, type SiteTheme } from '~/utils/site-theme';

/**
 * 站点明暗主题。存 cookie 而非 localStorage：SSR 阶段即可读到并写入 html[data-theme]，
 * 首屏不会先渲染默认主题再闪变。编辑器自身的明暗开关（useEditorTheme）与此独立。
 */
export function useSiteTheme() {
  const cookie = useCookie<string>(SITE_THEME_COOKIE, {
    default: () => DEFAULT_SITE_THEME,
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
  const theme = computed<SiteTheme>({
    get: () => normalizeSiteTheme(cookie.value),
    set: (value) => {
      cookie.value = normalizeSiteTheme(value);
    },
  });
  function toggle() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
  }
  return { theme, toggle };
}
