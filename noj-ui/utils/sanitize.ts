/**
 * HTML 净化工具（共享入口）。
 *
 * 政策（标签/属性白名单、协议、图片处置）在 `./sanitize-policy.ts`，服务端与
 * 客户端共用；本文件只负责按运行环境选择执行者：
 * - **服务端**：`sanitize-html`（真正的 HTML 解析器，实体解码交给解析器）。
 *   解析器由 `server/plugins/rich-text-sanitizer.ts` 在 Nitro 启动时注册，
 *   因此本模块**不**静态依赖 `sanitize-html`，客户端 bundle 不会带上它。
 * - **客户端**：DOMPurify（浏览器原生解析器）。
 *
 * **硬规则（2026-11-02 rc/v0.11 审计 F1）**：服务端净化不得用正则重写 HTML，
 * 也不得自行解码实体。旧实现（`simpleSanitize` + `decodeHtmlEntities`）已删除，
 * 不要以任何形式恢复：`javascript&#58alert(1)` 这类省略分号的数字实体会绕过手写
 * 协议检查，被浏览器解析成 `javascript:` URL（SSR 首屏点击触发 XSS）。
 */
import { buildClientConfig, buildServerOptions, decideImage } from './sanitize-policy.ts';

/** 净化参数。 */
export interface SanitizeInput {
  /** 是否允许直接加载站外 https 图片（缺省降级为链接）。 */
  allowExternalImages?: boolean;
}

/** 服务端解析型净化器签名（`sanitize-html` 的兼容子集）。 */
export type ServerSanitizer = (
  html: string,
  options: ReturnType<typeof buildServerOptions>,
) => string;

let serverSanitizer: ServerSanitizer | null = null;

/**
 * 注册服务端净化器（只允许 Nitro 启动插件调用）。
 *
 * @param sanitizer 解析型净化函数
 */
export function registerServerSanitizer(sanitizer: ServerSanitizer): void {
  serverSanitizer = sanitizer;
}

/** 把任意文本转义为可安全嵌入 HTML 的纯文本（仅用于净化不可用时的降级）。 */
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * 同步净化 HTML（SSR 首屏）。
 *
 * 净化器未注册（例如误在浏览器调用）时**降级为纯文本**（fail-closed）：
 * 宁可把富文本显示成转义后的源码，也不输出未净化的 HTML。
 */
export function sanitizeHtmlSync(
  raw: string,
  input: SanitizeInput = {},
): string {
  if (!serverSanitizer) return `<p>${escapeHtmlText(raw)}</p>`;
  try {
    return serverSanitizer(
      raw,
      buildServerOptions({
        allowExternalImages: input.allowExternalImages === true,
      }),
    );
  } catch {
    return `<p>${escapeHtmlText(raw)}</p>`;
  }
}

let purifyPromise: Promise<typeof import('dompurify').default> | null = null;

/**
 * 钩子里用到的最小 DOM 结构（只声明实际调用的成员）。
 *
 * 本文件同时被 Deno 单测（无 DOM 类型库）与浏览器 bundle 类型检查，因此不引用
 * 全局 `Element`；真正传进来的仍是 DOM 元素。
 */
interface DomNodeLike {
  nodeName: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  remove(): void;
  replaceWith(node: unknown): void;
  ownerDocument: { createElement(tag: string): DomNodeLike } | null;
  textContent: string | null;
}

function loadDompurify(): Promise<typeof import('dompurify').default> {
  if (!purifyPromise) {
    purifyPromise = import('dompurify').then((mod) => mod.default);
  }
  return purifyPromise;
}

/**
 * 异步净化 HTML（客户端水合后）。
 *
 * 使用 DOMPurify 执行与服务端相同的政策；图片处置在 `afterSanitizeAttributes`
 * 钩子里复用同一 `decideImage()` 结论（站内相对保留、非 https 降级为链接、
 * 未知协议丢弃）。净化器加载失败时同样降级为纯文本。
 */
export async function sanitizeHtmlAsync(
  raw: string,
  input: SanitizeInput = {},
): Promise<string> {
  const allowExternalImages = input.allowExternalImages === true;
  try {
    const purify = await loadDompurify();
    const { config } = buildClientConfig({ allowExternalImages });
    purify.removeHook('afterSanitizeAttributes');
    const applyImagePolicy = (raw: unknown): void => {
      const node = raw as DomNodeLike;
      if (node.nodeName !== 'IMG') return;
      const decision = decideImage(
        node.getAttribute('src') ?? '',
        node.getAttribute('alt') ?? '',
        allowExternalImages,
      );
      if (decision.kind === 'img') {
        for (const [name, value] of Object.entries(decision.attrs)) {
          node.setAttribute(name, value);
        }
        return;
      }
      const ownerDocument = node.ownerDocument;
      if (decision.kind === 'link' && ownerDocument) {
        const anchor = ownerDocument.createElement('a');
        anchor.setAttribute('href', decision.href);
        anchor.setAttribute('rel', 'nofollow noopener noreferrer');
        anchor.setAttribute('target', '_blank');
        anchor.textContent = decision.text;
        node.replaceWith(anchor);
        return;
      }
      node.remove();
    };
    // DOMPurify 的 hook 类型依赖 DOM 全局声明；本文件在无 DOM 库的 Deno 单测里也要
    // 通过类型检查，因此通过结构化的 addHook 视图调用。
    const addHook = purify.addHook as unknown as (
      name: string,
      hook: (node: unknown) => void,
    ) => void;
    addHook('afterSanitizeAttributes', applyImagePolicy);
    return purify.sanitize(raw, config);
  } catch {
    return `<p>${escapeHtmlText(raw)}</p>`;
  }
}
