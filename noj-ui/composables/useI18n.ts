import { translate } from '~/utils/i18n';

/**
 * 中文文案查询（站点只提供中文，语言切换已移除）。
 *
 * 保留 `t(key, params)` 形态，供登录 / 注册 / 搜索等页面从集中文案表取词。
 */
export function useI18n() {
  return { t: translate };
}
