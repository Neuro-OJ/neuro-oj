/**
 * 富文本净化**政策**（唯一事实源）。
 *
 * 背景（2026-11-02 rc/v0.11 审计 F1）：原 `utils/sanitize.ts` 的服务端分支用正则
 * 重写 HTML，并在协议检查前手写实体解码，只识别带分号的数字实体；浏览器接受
 * `&#58`（省略分号）这类形式，于是 `javascript&#58alert(1)` 通过协议检查、
 * 被浏览器解析成 `javascript:` URL —— SSR 首屏与降级路径存在点击触发的 XSS。
 *
 * 结论：**服务端不得用正则承担净化职责**。这里把放行规则集中成一份政策，
 * 两个实现分别用**真正的 HTML 解析器**执行它：
 * - 服务端：`sanitize-html`（htmlparser2 + `decodeEntities: true`，与浏览器实体
 *   解析对齐）；
 * - 客户端：DOMPurify（浏览器原生解析器）。
 *
 * 任何新增富文本入口都必须复用本文件，不得再写第二份白名单。
 */

/** 允许出现的标签（markdown-it + KaTeX + 表格语法产出的子集）。 */
export const SAFE_TAGS: readonly string[] = [
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
];

/**
 * 全部标签都允许的通用属性。
 *
 * 注意 `style` 刻意不在其中（NOJ-249）：未做 CSS 清洗前不得放行内联样式。
 * KaTeX 需要的内联样式在类名占位符回填阶段加入，不经过净化器。
 */
export const COMMON_ATTRS: readonly string[] = [
  'class',
  'title',
  'align',
  'start',
];

/** 按标签追加的属性。 */
export const TAG_ATTRS: Readonly<Record<string, readonly string[]>> = {
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'loading', 'referrerpolicy'],
  // markdown 任务列表渲染出的复选框：只允许纯展示属性
  input: ['type', 'checked', 'disabled'],
};

/** 允许的 URL 协议（相对 URL / 锚点不带协议，另由 `allowProtocolRelative` 约束）。 */
export const SAFE_SCHEMES: readonly string[] = [
  'http',
  'https',
  'mailto',
  'tel',
];

/**
 * 图片策略结论。
 *
 * - `img`：保留为图片（站内相对路径，或已允许的外链 https 图片）；
 * - `link`：降级成链接（外链 http(s) 图片、未允许外链图片时的 https 图片）；
 * - `drop`：直接丢弃（协议不安全、协议相对、空 src）。
 */
export type ImageDecision =
  | { kind: 'img'; attrs: Record<string, string> }
  | { kind: 'link'; href: string; text: string }
  | { kind: 'drop' };

/** 站内相对路径：以单个 `/` 开头（`//host` 是协议相对，必须排除）。 */
function isSitePath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//');
}

/**
 * 计算图片的处置方式。
 *
 * 与旧 `secureExternalImages()` 的三分支语义一致，但改由解析器提供的属性值
 * 参与判断（不再是正则重写标签）：
 * 1. 站内相对路径 → `img`（`loading=lazy`）；
 * 2. 非 https → `link`（只保留原文 alt 作为链接文本，缺省"外链图片"）；
 * 3. https → 允许外链图片时 `img`（`loading=lazy referrerpolicy=no-referrer`），
 *    否则 `link`。
 *
 * @param src 已由解析器解码的 `src` 属性原文
 * @param alt 已解码的 `alt` 属性原文
 * @param allowExternalImages 是否允许直接加载站外图片
 */
export function decideImage(
  src: string,
  alt: string,
  allowExternalImages: boolean,
): ImageDecision {
  const value = src.trim();
  if (isSitePath(value)) {
    return {
      kind: 'img',
      attrs: { src: value, loading: 'lazy', ...(alt ? { alt } : {}) },
    };
  }
  if (value.startsWith('https://')) {
    return allowExternalImages
      ? {
        kind: 'img',
        attrs: {
          src: value,
          loading: 'lazy',
          referrerpolicy: 'no-referrer',
          alt: alt || '外链图片',
        },
      }
      : { kind: 'link', href: value, text: alt || '外链图片' };
  }
  if (value.startsWith('http://')) {
    return { kind: 'link', href: value, text: alt || '外链图片' };
  }
  return { kind: 'drop' };
}

/** 服务端净化选项（`sanitize-html`）。 */
export interface ServerSanitizeOptions {
  readonly allowExternalImages: boolean;
}

/**
 * 构造服务端 `sanitize-html` 选项。
 *
 * 关键点：
 * - 使用默认 parser（`decodeEntities: true`），实体解码交给解析器，禁止自行正则解码；
 * - `disallowedTagsMode: "discard"`：未知标签丢标记留文本；`script`/`style` 属于
 *   `nonTextTags`，连内容一起丢弃；
 * - `allowedSchemesByTag.img` 只放 https/relative，http 图片先由 `transformTags`
 *   降级成链接再过滤属性，因此不会被提前丢成空标签。
 */
export function buildServerOptions(opts: ServerSanitizeOptions) {
  const allowedAttributes: Record<string, string[]> = {
    '*': [...COMMON_ATTRS],
  };
  for (const [tag, attrs] of Object.entries(TAG_ATTRS)) {
    allowedAttributes[tag] = [...attrs];
  }
  return {
    allowedTags: [...SAFE_TAGS],
    allowedAttributes,
    allowedSchemes: [...SAFE_SCHEMES],
    allowedSchemesByTag: { img: ['https'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard' as const,
    // KaTeX 依赖内联 style 定位分式/上下标；样式在净化**之后**由占位符回填，
    // 这里不放行 style，避免引入未清洗的 CSS。
    transformTags: {
      img: (
        _tagName: string,
        attribs: Record<string, string>,
      ): {
        tagName: string;
        attribs: Record<string, string>;
        text?: string;
      } => {
        const decision = decideImage(
          attribs.src ?? '',
          attribs.alt ?? '',
          opts.allowExternalImages,
        );
        if (decision.kind === 'img') {
          return { tagName: 'img', attribs: decision.attrs };
        }
        if (decision.kind === 'link') {
          return {
            tagName: 'a',
            attribs: {
              href: decision.href,
              rel: 'nofollow noopener noreferrer',
              target: '_blank',
            },
            text: decision.text,
          };
        }
        // 丢弃：换成空 span，属性过滤后不会留下任何可执行内容
        return { tagName: 'span', attribs: {} };
      },
    },
  };
}

/** 客户端净化配置（DOMPurify 选项 + 图片策略参数）。 */
export interface ClientSanitizeOptions {
  /** DOMPurify 配置。 */
  readonly config: Record<string, unknown>;
  /** 图片策略参数；在 `afterSanitizeAttributes` 钩子里消费。 */
  readonly allowExternalImages: boolean;
}

/** 构造客户端 DOMPurify 配置（浏览器原生解析器执行同一政策）。 */
export function buildClientConfig(
  opts: ServerSanitizeOptions,
): ClientSanitizeOptions {
  const allowedAttributes: Record<string, string[]> = {
    '*': [...COMMON_ATTRS],
  };
  for (const [tag, attrs] of Object.entries(TAG_ATTRS)) {
    allowedAttributes[tag] = [...attrs];
  }
  return {
    config: {
      ALLOWED_TAGS: [...SAFE_TAGS],
      ALLOWED_ATTR: Object.values(allowedAttributes).flat(),
      // 允许相对 URL；其余必须命中 SAFE_SCHEMES（大小写不敏感的 scheme 前缀）
      ALLOWED_URI_REGEXP: new RegExp(
        `^(?:(?:${SAFE_SCHEMES.join('|')}):|(?![a-zA-Z][a-zA-Z0-9+.-]*:))`,
        'i',
      ),
      FORBID_ATTR: ['style'],
      FORBID_TAGS: ['style'],
      ALLOW_DATA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
    },
    allowExternalImages: opts.allowExternalImages,
  };
}
