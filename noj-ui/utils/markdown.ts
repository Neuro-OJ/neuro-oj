/**
 * Markdown 纯文本工具。
 *
 * 社区列表卡片与列表页预览使用 `stripMarkdown` 把 Markdown 正文转成
 * 可读的纯文本摘要，避免与详情页的 `MarkdownRenderer` 渲染结果不一致
 * （代码块 / 公式在纯文本预览里是乱码）。
 */

/** 剥离 Markdown 语法为纯文本，可选截断到 maxLength 字符。 */
export function stripMarkdown(content: string, maxLength = 160): string {
  if (!content) return '';
  let text = content;

  // 代码块整体移除（预览无需展示代码）
  text = text.replace(/```[\s\S]*?```/g, ' ');
  // 行内代码保留内容
  text = text.replace(/`([^`\n]+)`/g, '$1');
  // 图片 ![alt](url) → alt
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 链接 [text](url) → text
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // 块级与行内公式
  text = text.replace(/\$\$[\s\S]*?\$\$/g, ' ');
  text = text.replace(/\$([^$\n]+)\$/g, '$1');
  // 标题、引用、列表标记、分隔线
  text = text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^-{3,}$/gm, '')
    // 粗体 / 下划线 / 斜体 / 删除线
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1');
  // 残留 HTML 标签
  text = text.replace(/<[^>]+>/g, ' ');

  // 折叠空白
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + '…';
}
