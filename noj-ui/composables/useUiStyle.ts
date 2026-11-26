import { DEFAULT_UI_STYLE, normalizeUiStyle, UI_STYLE_COOKIE, type UiStyle } from '~/utils/ui-styles';

/** 当前界面风格（cookie 持久化，SSR 可读）；写入时自动规范化。 */
export function useUiStyle() {
  const cookie = useCookie<string>(UI_STYLE_COOKIE, {
    default: () => DEFAULT_UI_STYLE,
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
  return computed<UiStyle>({
    get: () => normalizeUiStyle(cookie.value),
    set: (value) => {
      cookie.value = normalizeUiStyle(value);
    },
  });
}
