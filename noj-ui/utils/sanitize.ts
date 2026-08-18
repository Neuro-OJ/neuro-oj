/**
 * HTML 净化工具。
 * 优先使用 DOMPurify，不可用时使用标签白名单降级。
 */

let purifyPromise: Promise<typeof import('dompurify').default> | null = null;

function loadDompurify(): Promise<typeof import('dompurify').default> {
  if (!purifyPromise) {
    purifyPromise = import('dompurify').then((mod) => mod.default);
  }
  return purifyPromise;
}

// 白名单标签 —— markdown-it + KaTeX 生成的标签子集
const SAFE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'code',
  'dd',
  'del',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'input',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

// NOJ-249：移除 style 白名单（未做 CSS 清洗前不得放行）。
const SAFE_ATTR_RE = /^(?:href|title|alt|src|class|width|height|target|rel|align|start)$/i;

/** 允许的 URL 协议（相对 URL / 锚点直接放行）。 */
const SAFE_URL_PROTOCOLS = /^(?:https?|mailto|tel):/i;

/** 解码常见 HTML 实体（数字 + named），避免 jav&#x61;script: 绕过协议检查。 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#([0-9]+);/g, (_m, dec: string) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(
      /&(nbsp|amp|lt|gt|quot|apos|colon|tab|newline);/gi,
      (_m, name: string) =>
        ({
          nbsp: '\u00a0',
          amp: '&',
          lt: '<',
          gt: '>',
          quot: '"',
          apos: "'",
          colon: ':',
          tab: '\t',
          newline: '\n',
        })[name.toLowerCase()] ?? '',
    );
}

/** 归一化 URL 用于协议判断：实体解码 + 去除浏览器会忽略的控制/空白字符。 */
function isUnsafeUrl(value: string): boolean {
  const decoded = decodeHtmlEntities(value).replace(
    // deno-lint-ignore no-control-regex -- 需要剥离 URL 中的控制字符
    /[\u0000-\u0020\u007f-\u009f\u00a0]+/g,
    '',
  );
  if (!/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return false;
  return !SAFE_URL_PROTOCOLS.test(decoded);
}

/**
 * 简单标签白名单净化器 —— DOMPurify 不可用时的最后防线。
 * 移除所有不在白名单中的标签；过滤不在白名单中的属性；
 * 阻止 javascript:/data:/vbscript:/file: 等危险协议（含实体与控制字符变体）。
 */
function simpleSanitize(raw: string): string {
  // 首先移除所有 script / style 标签及内容
  let html = raw.replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '');

  // 过滤标签和属性
  html = html.replace(
    /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g,
    (_match, close: string, tag: string, attrs: string) => {
      const tagLower = tag.toLowerCase();
      if (!SAFE_TAGS.has(tagLower)) {
        // 不认识的标签 → 转为纯文本显示
        return `&lt;${close}${tag}${attrs}&gt;`;
      }
      if (close) return `</${tagLower}>`;

      // 过滤属性 —— 只保留白名单属性，并阻止 javascript: 协议
      const safeAttrs = attrs.replace(
        /\s*([a-zA-Z-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g,
        (_am, attrName: string, dq: string, sq: string, nq: string) => {
          const attrLower = attrName.toLowerCase();
          if (!SAFE_ATTR_RE.test(attrLower)) return '';
          const val = dq ?? sq ?? nq ?? '';
          if ((attrLower === 'href' || attrLower === 'src') && isUnsafeUrl(val)) {
            return '';
          }
          if (dq != null) return ` ${attrLower}="${dq.replace(/"/g, '&quot;')}"`;
          if (sq != null) return ` ${attrLower}='${sq.replace(/'/g, '&#039;')}'`;
          return val ? ` ${attrLower}="${val}"` : ` ${attrLower}`;
        },
      );
      return `<${tagLower}${safeAttrs}>`;
    },
  );

  return html;
}

/**
 * 同步净化 HTML（用于 SSR 首屏）。
 * 在客户端可用后由组件自行切换到 DOMPurify。
 */
export function sanitizeHtmlSync(raw: string): string {
  return simpleSanitize(raw);
}

/**
 * 异步净化 HTML（用于客户端水合后）。
 * 优先使用 DOMPurify，加载失败时自动降级到白名单方案。
 */
export async function sanitizeHtmlAsync(raw: string): Promise<string> {
  try {
    const purify = await loadDompurify();
    return purify.sanitize(raw);
  } catch {
    // DOMPurify 加载失败 → 使用标签白名单降级
    return simpleSanitize(raw);
  }
}
