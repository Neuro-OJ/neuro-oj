/**
 * 页脚备案展示逻辑（纯函数，便于单测）。
 *
 * 未配置备案号时不渲染任何备案节点；配置后按类型给出链接（缺省用官方查询页）。
 */

export interface SiteMeta {
  icp_number: string;
  icp_url: string;
  police_number: string;
  police_url: string;
  /** 个人信息处理者名称（PIPL 告知） */
  operator_name: string;
  /** 处理者联系方式（PIPL 告知） */
  contact: string;
  /** 部署补充说明（存储区域/保留期限/备份/第三方服务；PIPL 告知） */
  deployment_notes: string;
  /** 第三方服务清单（JSON 字符串） */
  third_parties: string;
}

export const EMPTY_SITE_META: SiteMeta = {
  icp_number: '',
  icp_url: '',
  police_number: '',
  police_url: '',
  operator_name: '',
  contact: '',
  deployment_notes: '',
  third_parties: '',
};

export interface FilingLink {
  label: string;
  url: string;
}

/**
 * 由站点元信息计算页脚应展示的备案链接。
 *
 * @param meta 站点元信息
 * @returns 备案链接列表；无备案时为空数组（页脚不渲染）
 */
export function buildFilingLinks(meta: SiteMeta): FilingLink[] {
  const links: FilingLink[] = [];
  if (meta.icp_number) {
    links.push({
      label: meta.icp_number,
      url: meta.icp_url || 'https://beian.miit.gov.cn/',
    });
  }
  if (meta.police_number) {
    links.push({
      label: meta.police_number,
      url: meta.police_url || 'https://beian.mps.gov.cn/',
    });
  }
  return links;
}

/** 第三方服务条目。 */
export interface ThirdParty {
  name: string;
  purpose?: string;
  data?: string;
}

/**
 * 解析第三方服务清单（JSON 字符串）。非法 JSON/空值时返回空数组，
 * 避免政策页因运营者填错格式而崩溃。
 *
 * @param raw `legal_third_parties` 的原始值
 * @returns 归一化的第三方条目列表
 */
export function buildThirdPartyList(raw: string): ThirdParty[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => x && typeof x === 'object' && typeof x.name === 'string' && x.name.trim() !== '')
      .map((x) => ({
        name: String(x.name),
        purpose: x.purpose !== undefined && x.purpose !== null ? String(x.purpose) : undefined,
        data: x.data !== undefined && x.data !== null ? String(x.data) : undefined,
      }));
  } catch {
    return [];
  }
}
