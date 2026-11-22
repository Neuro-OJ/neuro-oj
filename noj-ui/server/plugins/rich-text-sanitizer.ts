import sanitizeHtml from 'sanitize-html';
import { registerServerSanitizer } from '../../utils/sanitize';

/**
 * 在 Nitro 启动时注册 SSR 富文本净化器（`sanitize-html`）。
 *
 * 为什么放在服务端插件而不是 `utils/sanitize.ts` 里静态 import：
 * - 组件 `MarkdownRenderer.vue` 同时被客户端和 SSR 引用，静态 import 会把
 *   `sanitize-html` + htmlparser2 打进浏览器 bundle；
 * - SSR 首屏需要**同步**净化（watcher 不会在渲染前 await），因此不能靠
 *   `import.meta.client` 分支里的动态 import。
 *
 * 服务端插件在启动时 `import` 一次、把解析器注册进共享模块，SSR 就能同步调用，
 * 而客户端永远拿不到这个模块（未注册 → fail-closed 降级为纯文本）。
 *
 * 政策本身在 `utils/sanitize-policy.ts`，与客户端 DOMPurify 共用。
 */
export default defineNitroPlugin(() => {
  registerServerSanitizer((html, options) => sanitizeHtml(html, options));
});
