import type { DomainProblemDetail, ProblemSample } from "./types";

/** 转义 HTML 特殊字符，防止任意标签或脚本注入。 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineMarkdown(escapedText: string): string {
  return escapedText
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
}

/**
 * 安全 Markdown 渲染器：先整体 HTML 转义，再按块级与行内语法转换，
 * 禁止任何原始 HTML 注入，链接仅允许 http/https。
 */
export function renderMarkdownSafe(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeLang = "";
  let inList = false;

  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const fence = rawLine.match(/^```([A-Za-z0-9_-]*)\s*$/);
    if (fence) {
      closeList();
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = fence[1] ?? "";
        codeLines = [];
      } else {
        html.push(
          `<pre><code data-lang="${escapeHtml(codeLang)}">${escapeHtml(
            codeLines.join("\n"),
          )}</code></pre>`,
        );
        inCodeBlock = false;
        codeLang = "";
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    const trimmed = rawLine.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(
        `<h${level}>${renderInlineMarkdown(escapeHtml(heading[2]))}</h${level}>`,
      );
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      closeList();
      html.push("<hr />");
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      html.push(
        `<blockquote>${renderInlineMarkdown(escapeHtml(quote[1]))}</blockquote>`,
      );
      continue;
    }

    const listItem = trimmed.match(/^[-*+]\s+(.+)$/);
    if (listItem) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${renderInlineMarkdown(escapeHtml(listItem[1]))}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${renderInlineMarkdown(escapeHtml(trimmed))}</p>`);
  }

  closeList();
  if (inCodeBlock) {
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  return html.join("\n");
}

function renderSamples(samples: readonly ProblemSample[]): string {
  if (samples.length === 0) return "";
  const cards = samples
    .map((sample, index) => {
      const inputBlock =
        sample.input !== undefined
          ? `<div class="sample-col"><div class="sample-label">输入</div><pre>${escapeHtml(sample.input)}</pre></div>`
          : "";
      const outputBlock =
        sample.output !== undefined
          ? `<div class="sample-col"><div class="sample-label">输出</div><pre>${escapeHtml(sample.output)}</pre></div>`
          : "";
      const explanation = sample.explanation
        ? `<div class="sample-note">${renderMarkdownSafe(sample.explanation)}</div>`
        : "";
      return `<section class="sample-card"><h4>样例 ${index + 1}</h4><div class="sample-grid">${inputBlock}${outputBlock}</div>${explanation}</section>`;
    })
    .join("\n");
  return `<section class="section"><h2>样例</h2>${cards}</section>`;
}

/** 构造题面预览 Webview 的完整安全 HTML。 */
export function renderStatementHtml(
  detail: DomainProblemDetail,
  meta: { domainSlug: string; reference: string },
): string {
  const title = detail.content.title || meta.reference;
  const mode =
    detail.submission_mode ?? detail.content.submission_mode ?? "code";
  const judgeType = detail.judge_type ?? detail.content.judge_type ?? "dual";
  const limits = detail.limits
    ? `${detail.limits.time_limit_ms ?? "-"} ms / ${detail.limits.memory_limit_mb ?? "-"} MiB`
    : "默认限制";
  const description = detail.content.description
    ? renderMarkdownSafe(detail.content.description)
    : "<p>暂无题面正文。</p>";
  const samplesHtml = renderSamples(detail.content.samples ?? []);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #0b0f19);
    --panel: var(--vscode-editorWidget-background, #131b2e);
    --border: var(--vscode-panel-border, #1e293b);
    --text: var(--vscode-editor-foreground, #f8fafc);
    --muted: var(--vscode-descriptionForeground, #94a3b8);
    --primary: #38bdf8;
    --signal: #00e07a;
  }
  body.vscode-light {
    --bg: #f5f8fc;
    --panel: #ffffff;
    --border: #e1e8f2;
    --text: #0f172a;
    --muted: #475569;
    --primary: #0284c7;
    --signal: #059669;
  }
  body {
    margin: 0; padding: 20px 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.65;
  }
  .header {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 6px; padding: 16px 20px; margin-bottom: 18px;
  }
  .title { margin: 0 0 10px; font-size: 20px; font-weight: 600; }
  .badges { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; }
  .badge {
    padding: 2px 8px; border-radius: 4px;
    border: 1px solid var(--border); color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .badge.accent { color: var(--primary); border-color: var(--primary); }
  .badge.signal { color: var(--signal); border-color: var(--signal); }
  .section {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 6px; padding: 16px 20px; margin-bottom: 16px;
  }
  pre {
    background: rgba(127, 127, 127, 0.12);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 10px 12px; overflow-x: auto; font-size: 13px;
  }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  blockquote {
    margin: 8px 0; padding: 4px 12px;
    border-left: 3px solid var(--primary); color: var(--muted);
  }
  .sample-card { margin-top: 12px; }
  .sample-card h4 { margin: 0 0 8px; font-size: 13px; color: var(--muted); }
  .sample-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .sample-label { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  a { color: var(--primary); }
</style>
</head>
<body>
  <header class="header">
    <h1 class="title">${escapeHtml(meta.reference)} · ${escapeHtml(title)}</h1>
    <div class="badges">
      <span class="badge accent">域：${escapeHtml(meta.domainSlug)}</span>
      <span class="badge signal">版本：V${escapeHtml(String(detail.version))}</span>
      <span class="badge">模式：${escapeHtml(mode)}</span>
      <span class="badge">评测类型：${escapeHtml(judgeType)}</span>
      <span class="badge">资源限制：${escapeHtml(limits)}</span>
    </div>
  </header>
  <main class="section">${description}</main>
  ${samplesHtml}
</body>
</html>`;
}
