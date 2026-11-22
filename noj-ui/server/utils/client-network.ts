/** 与既有代理共用客户端网络头规范化，不信任浏览器自行声明的 IP。 */
function normalizeIp(ip?: string | null): string | undefined {
  if (!ip) return undefined;
  let value = ip.trim();
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  if (value.startsWith('[') && value.includes(']')) {
    value = value.slice(1, value.indexOf(']'));
  }
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  return value || undefined;
}

export function getClientNetworkHeaders(event: {
  node: {
    req: {
      headers: Record<string, string | string[] | undefined>;
      socket?: { remoteAddress?: string };
    };
  };
  headers: Headers;
}): Record<string, string> {
  const out: Record<string, string> = {};
  const peerIp = normalizeIp(event.node.req.socket?.remoteAddress);
  const existingXff = event.headers.get('x-forwarded-for')?.trim() ?? '';

  if (existingXff && peerIp) {
    // 总是把当前 TCP 对端放到最右，确保 core 从右往左解析时先看到真实 socket IP，
    // 防止攻击者在 XFF 里夹带任意 IP 来伪造来源。
    out['x-forwarded-for'] = `${existingXff}, ${peerIp}`;
  } else if (peerIp) {
    out['x-forwarded-for'] = peerIp;
  } else if (existingXff) {
    out['x-forwarded-for'] = existingXff;
  }

  if (peerIp) out['x-real-ip'] = peerIp;

  const ua = event.headers.get('user-agent');
  if (ua) out['user-agent'] = ua;
  return out;
}
