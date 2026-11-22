/** 只接受站内回跳，拒绝协议、双斜线、反斜线和控制字符。 */
export function safeAuthRedirect(value: unknown, fallback = '/') {
  if (
    typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  ) return fallback;
  try {
    const decoded = decodeURIComponent(value.split(/[?#]/)[0] ?? '');
    if (
      decoded.startsWith('//') || decoded.includes('\\') ||
      Array.from(decoded).some((character) => character.charCodeAt(0) < 32)
    ) return fallback;
    const url = new URL(value, 'https://noj.invalid');
    return url.origin === 'https://noj.invalid' ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch {
    return fallback;
  }
}
