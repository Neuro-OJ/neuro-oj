/**
 * IPv4 CIDR 工具（issue #102）。
 *
 * 支持裸 IP（1.2.3.4）与 CIDR（10.0.0.0/8）两种格式。
 * IPv6 暂不支持——OJ 场景几乎都是 IPv4，零新依赖；后续可加。
 */

export interface CidrRange {
  /** 网络地址（32-bit unsigned） */
  base: number;
  /** 子网掩码（32-bit unsigned；裸 IP 时为 0xffffffff） */
  mask: number;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;

/** 字符串 IPv4 转 32-bit unsigned int。非法 IP 返 null。 */
export function ipv4ToInt(ip: string): number | null {
  const m = IPV4_RE.exec(ip);
  if (!m) return null;
  const octets = [m[1], m[2], m[3], m[4]].map((s) => parseInt(s!, 10));
  for (const o of octets) {
    if (o < 0 || o > 255) return null;
  }
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) |
    octets[3]!) >>> 0;
}

/** 解析 CIDR 字符串。`1.2.3.4` 等价于 `1.2.3.4/32`。 */
export function parseCidr(cidr: string): CidrRange | null {
  const m = IPV4_RE.exec(cidr);
  if (!m) return null;
  for (let i = 1; i <= 4; i++) {
    const o = parseInt(m[i]!, 10);
    if (o < 0 || o > 255) return null;
  }
  const prefix = m[5] === undefined ? 32 : parseInt(m[5], 10);
  if (prefix < 0 || prefix > 32) return null;

  const base = ((parseInt(m[1]!, 10) << 24) | (parseInt(m[2]!, 10) << 16) |
    (parseInt(m[3]!, 10) << 8) | parseInt(m[4]!, 10)) >>> 0;
  // 32 位掩码：前 prefix 位为 1
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: base & mask, mask };
}

/** IP 是否在 CIDR 范围内（IP 必须是合法 IPv4 字符串）。 */
export function ipInRange(ip: string, range: CidrRange): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return (n & range.mask) === range.base;
}

/** 解析 IP/CIDR 是否合法。CIDR 范围不能是 0.0.0.0/0（防封整个 IPv4）。 */
export function isValidIpOrCidr(value: string): boolean {
  const range = parseCidr(value);
  if (range === null) return false;
  // 拒绝 0.0.0.0/0（即 0.0.0.0，掩码 0）
  if (range.mask === 0) return false;
  return true;
}

/**
 * 主入口：检查 clientIp 是否被 ban 列表中任一条目命中。
 * 无效 IP 永不命中（避免 false positive）。
 */
export function isBannedIp(clientIp: string, bans: string[]): boolean {
  if (!clientIp || clientIp === "unknown") return false;
  for (const b of bans) {
    const range = parseCidr(b);
    if (range && ipInRange(clientIp, range)) return true;
  }
  return false;
}
