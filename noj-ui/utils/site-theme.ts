/** 站点明暗主题；token 定义见 assets/css/main.css 的 html[data-theme] 段。 */
export const SITE_THEMES = ['dark', 'light'] as const;
export type SiteTheme = (typeof SITE_THEMES)[number];

export const SITE_THEME_COOKIE = 'noj-theme';

/** 默认深色（无 cookie 或值非法时使用）。 */
export const DEFAULT_SITE_THEME: SiteTheme = 'dark';

/** 只接受已知主题，cookie 被篡改或过期值一律回退默认。 */
export function normalizeSiteTheme(value: unknown): SiteTheme {
  return SITE_THEMES.includes(value as SiteTheme) ? value as SiteTheme : DEFAULT_SITE_THEME;
}
