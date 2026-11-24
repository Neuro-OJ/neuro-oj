import * as crypto from "node:crypto";
import { escapeHtml } from "./statementHtml";
import type {
  EvaluationBadcase,
  EvaluationDimensionScore,
  EvaluationFeedback,
  LlmTraceEntry,
} from "./types";

/** 生成纯 SVG 能力维度雷达图（少于 3 维时退化为进度条视图）。 */
export function renderRadarSvg(
  dimensions: readonly EvaluationDimensionScore[],
): string {
  if (dimensions.length === 0) return "";
  if (dimensions.length < 3) {
    return dimensions
      .map((dim) => {
        const pct = Math.max(
          0,
          Math.min(100, (dim.score / Math.max(dim.maxScore, 1)) * 100),
        );
        return `<div class="dim-bar-row"><span>${escapeHtml(dim.name)}</span><div class="dim-bar-track"><div class="dim-bar-fill" style="width:${pct.toFixed(1)}%"></div></div><span class="num">${dim.score.toFixed(1)}/${dim.maxScore}</span></div>`;
      })
      .join("");
  }

  const size = 280;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 86;
  const count = dimensions.length;

  const pointAt = (index: number, ratio: number): [number, number] => {
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
    return [
      cx + Math.cos(angle) * radius * ratio,
      cy + Math.sin(angle) * radius * ratio,
    ];
  };

  const rings = [0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const pts = dimensions
        .map((_, idx) =>
          pointAt(idx, ratio)
            .map((n) => n.toFixed(1))
            .join(","),
        )
        .join(" ");
      return `<polygon points="${pts}" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="1" />`;
    })
    .join("");

  const axes = dimensions
    .map((dim, idx) => {
      const [x, y] = pointAt(idx, 1);
      const [lx, ly] = pointAt(idx, 1.24);
      const anchor = lx < cx - 8 ? "end" : lx > cx + 8 ? "start" : "middle";
      return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="currentColor" stroke-opacity="0.2" stroke-width="1" />
<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" fill="currentColor" font-size="11">${escapeHtml(dim.name)} (${dim.score.toFixed(0)})</text>`;
    })
    .join("");

  const valuePts = dimensions
    .map((dim, idx) => {
      const ratio = Math.max(
        0,
        Math.min(1, dim.score / Math.max(dim.maxScore, 1)),
      );
      return pointAt(idx, ratio)
        .map((n) => n.toFixed(1))
        .join(",");
    })
    .join(" ");

  return `<svg viewBox="0 0 ${size} ${size}" class="radar-svg" role="img" aria-label="能力维度雷达图">
    ${rings}
    ${axes}
    <polygon points="${valuePts}" fill="#38bdf8" fill-opacity="0.28" stroke="var(--primary, #0369a1)" stroke-width="2" />
  </svg>`;
}

function renderBadcases(badcases: readonly EvaluationBadcase[]): string {
  if (badcases.length === 0) return "";
  const items = badcases
    .map((bc) => {
      const locBtn = bc.location
        ? `<button class="loc-link" data-file="${escapeHtml(bc.location.file)}" data-line="${bc.location.line}">${escapeHtml(bc.location.file)}:${bc.location.line}</button>`
        : "";
      const msg = bc.message
        ? `<div class="bc-msg">${escapeHtml(bc.message)}</div>`
        : "";
      const inputHtml =
        bc.input !== undefined
          ? `<div class="diff-col"><div class="diff-label">输入</div><pre>${escapeHtml(bc.input)}</pre></div>`
          : "";
      const diffHtml =
        bc.expected !== undefined || bc.actual !== undefined
          ? `<div class="diff-grid">
              ${inputHtml}
              <div class="diff-col"><div class="diff-label">期望输出</div><pre>${escapeHtml(bc.expected ?? "-")}</pre></div>
              <div class="diff-col"><div class="diff-label">实际输出</div><pre>${escapeHtml(bc.actual ?? "-")}</pre></div>
            </div>`
          : inputHtml;
      return `<article class="badcase-card">
        <div class="badcase-head">
          <span class="badcase-id">${escapeHtml(bc.caseId)}</span>
          <span class="pill err">${escapeHtml(bc.status)}</span>
          ${locBtn}
        </div>
        ${msg}
        ${diffHtml}
      </article>`;
    })
    .join("\n");
  return `<section class="panel"><h2>失败用例对比 (Badcases)</h2>${items}</section>`;
}

function renderTraces(traces: readonly LlmTraceEntry[]): string {
  if (traces.length === 0) return "";
  const maxEnd = Math.max(
    1,
    ...traces.map((t) => t.startedAtMs + Math.max(t.durationMs, 1)),
  );
  const rows = traces
    .map((trace) => {
      const leftPct = Math.min(95, (trace.startedAtMs / maxEnd) * 100);
      const widthPct = Math.max(
        4,
        Math.min(100 - leftPct, (Math.max(trace.durationMs, 1) / maxEnd) * 100),
      );
      return `<div class="trace-row">
        <div class="trace-meta">
          <span class="num">#${trace.index}</span>
          <strong>${escapeHtml(trace.model)}</strong>
          <span class="pill ${trace.status === "ok" ? "ok" : "err"}">${escapeHtml(trace.status)}</span>
          <span class="num muted">${trace.durationMs} ms · ${trace.promptTokens}→${trace.completionTokens} tok</span>
        </div>
        <div class="waterfall-track">
          <div class="waterfall-bar" style="left:${leftPct.toFixed(1)}%;width:${widthPct.toFixed(1)}%"></div>
        </div>
        <details class="trace-detail">
          <summary>请求 / 响应摘要</summary>
          <div class="diff-grid">
            <div class="diff-col"><div class="diff-label">请求</div><pre>${escapeHtml(trace.requestPreview || "-")}</pre></div>
            <div class="diff-col"><div class="diff-label">响应</div><pre>${escapeHtml(trace.responsePreview || "-")}</pre></div>
          </div>
        </details>
      </div>`;
    })
    .join("\n");
  return `<section class="panel"><h2>LLM 调用 Trace 瀑布流</h2>${rows}</section>`;
}

/** 生成评测报告 Webview HTML。 */
export function renderReportHtml(
  feedback: EvaluationFeedback,
  nonce = crypto.randomBytes(16).toString("hex"),
): string {
  const sourceBadge =
    feedback.source === "local_mock"
      ? "本地 Mock"
      : feedback.source === "self_test"
        ? "云端 Self-Test"
        : "正式提交";
  const scoreText =
    feedback.hidden || feedback.score === null
      ? "-"
      : `${feedback.score.toFixed(2)} / ${feedback.maxScore}`;
  const isPass =
    /^(AC|PASS|PASSED|finished|ok)$/i.test(feedback.status) &&
    (feedback.score === null || feedback.score >= feedback.maxScore);
  const statusClass = feedback.hidden
    ? "muted"
    : isPass
      ? "ok"
      : /error|fail|WA|RE|TLE|MLE/i.test(feedback.status)
        ? "err"
        : "warn";

  const metrics: Array<{ label: string; value: string }> = [
    { label: "得分", value: scoreText },
    {
      label: "耗时",
      value: feedback.timeMs != null ? `${feedback.timeMs} ms` : "-",
    },
    {
      label: "内存",
      value: feedback.memoryKb != null ? `${feedback.memoryKb} KiB` : "-",
    },
    {
      label: "Token 用量",
      value: feedback.metering
        ? `${feedback.metering.totalTokens} (${feedback.metering.promptTokens}/${feedback.metering.completionTokens})`
        : "-",
    },
    {
      label: "估算成本",
      value:
        feedback.metering?.costUsd != null
          ? `$${feedback.metering.costUsd.toFixed(4)}`
          : "-",
    },
    {
      label: "LLM 调用",
      value: feedback.metering ? `${feedback.metering.callCount} 次` : "-",
    },
  ];

  const metricsHtml = metrics
    .map(
      (m) =>
        `<div class="metric-card"><div class="metric-label">${escapeHtml(m.label)}</div><div class="metric-value num">${escapeHtml(m.value)}</div></div>`,
    )
    .join("");

  const radarHtml = feedback.dimensions.length
    ? `<section class="panel"><h2>分项能力雷达</h2><div class="radar-wrap">${renderRadarSvg(feedback.dimensions)}</div></section>`
    : "";

  const locationsHtml = feedback.locations.length
    ? `<section class="panel"><h2>源码定位跳转</h2><div class="loc-list">${feedback.locations
        .map(
          (loc) =>
            `<button class="loc-link" data-file="${escapeHtml(loc.file)}" data-line="${loc.line}">${escapeHtml(loc.file)}:${loc.line}</button>`,
        )
        .join(" ")}</div></section>`
    : "";

  const outputHtml = feedback.output
    ? `<section class="panel"><h2>评测输出</h2><pre>${escapeHtml(feedback.output)}</pre>${feedback.outputTruncated ? '<p class="muted">[输出已截断]</p>' : ""}</section>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(feedback.title)}</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #0b1120);
    --panel: var(--vscode-editorWidget-background, #111827);
    --sunken: var(--vscode-textCodeBlock-background, #070b14);
    --border: var(--vscode-panel-border, #1e293b);
    --text: var(--vscode-editor-foreground, #f8fafc);
    --text-secondary: var(--vscode-descriptionForeground, #94a3b8);
    --muted: #64748b;
    --primary: #38bdf8; --ok: #00e07a; --warn: #fbbf24; --err: #fb7185;
  }
  body.vscode-light {
    --bg: #f7f8fa; --panel: #ffffff; --sunken: #f1f5f9; --border: #e2e8f0;
    --text: #0f172a; --text-secondary: #475569; --muted: #64748b;
    --primary: #0369a1; --ok: #047857; --warn: #b45309; --err: #be123c;
  }
  body { margin: 0; padding: 20px 24px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
  .num { font-variant-numeric: tabular-nums; }
  .muted { color: var(--text-secondary); }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 16px 20px; margin-bottom: 16px; }
  .panel h2 { margin: 0 0 12px; font-size: 15px; }
  .hero { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .hero h1 { margin: 0; font-size: 18px; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; border: 1px solid var(--border); color: var(--text-secondary); }
  .pill.ok { color: var(--ok); border-color: var(--ok); }
  .pill.warn { color: var(--warn); border-color: var(--warn); }
  .pill.err { color: var(--err); border-color: var(--err); }
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .metric-card { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; }
  .metric-label { font-size: 12px; color: var(--muted); }
  .metric-value { font-size: 16px; font-weight: 600; margin-top: 4px; }
  .radar-wrap { display: flex; flex-direction: column; align-items: center; }
  .radar-svg { width: 280px; height: 280px; max-width: 100%; }
  .dim-bar-row { display: grid; grid-template-columns: 120px 1fr 80px; gap: 10px; align-items: center; width: 100%; margin: 6px 0; font-size: 13px; }
  .dim-bar-track { height: 8px; background: var(--sunken); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
  .dim-bar-fill { height: 100%; background: var(--primary); }
  .badcase-card, .trace-row { border-top: 1px solid var(--border); padding-top: 10px; margin-top: 10px; }
  .badcase-card:first-of-type, .trace-row:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
  .badcase-head, .trace-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
  .diff-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
  .diff-label { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
  pre { margin: 0; padding: 8px 10px; background: var(--sunken); border: 1px solid var(--border); border-radius: 4px; overflow-x: auto; font-size: 12px; }
  .waterfall-track { position: relative; height: 10px; background: var(--sunken); border: 1px solid var(--border); border-radius: 4px; margin: 6px 0; }
  .waterfall-bar { position: absolute; top: 0; bottom: 0; background: var(--primary); border-radius: 4px; }
  .loc-link { background: transparent; color: var(--primary); border: 1px solid var(--primary); border-radius: 4px; padding: 2px 8px; cursor: pointer; font-family: ui-monospace, monospace; font-size: 12px; }
  .loc-list { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
</head>
<body>
  <header class="panel hero">
    <div>
      <h1>${escapeHtml(feedback.title)}</h1>
      ${feedback.summary ? `<p class="muted" style="margin:6px 0 0">${escapeHtml(feedback.summary)}</p>` : ""}
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <span class="pill">${escapeHtml(sourceBadge)}</span>
      <span class="pill ${statusClass}">${escapeHtml(feedback.status)}</span>
    </div>
  </header>
  <section class="metrics">${metricsHtml}</section>
  ${radarHtml}
  ${locationsHtml}
  ${renderBadcases(feedback.badcases)}
  ${renderTraces(feedback.traces)}
  ${outputHtml}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener("click", (event) => {
      const target = event.target.closest(".loc-link");
      if (!target) return;
      vscode.postMessage({
        type: "openLocation",
        file: target.getAttribute("data-file"),
        line: Number(target.getAttribute("data-line"))
      });
    });
  </script>
</body>
</html>`;
}
