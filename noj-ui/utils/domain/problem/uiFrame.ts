/**
 * 界面题 iframe 的文档构造与消息协议（纯函数，便于单测）。
 *
 * 题包自带的 `ui.html` 运行在沙箱 iframe 里，通过注入的 `window.NOJ` 与宿主通信：
 *
 * | 方向 | 消息 | 说明 |
 * |---|---|---|
 * | 界面 → 宿主 | `{type:'ready'}` | 脚本加载完成，宿主回复 `init` |
 * | 界面 → 宿主 | `{type:'values', values}` | 参数变化（整份替换） |
 * | 界面 → 宿主 | `{type:'submit'}` / `{type:'self-test'}` | 请求提交评测 / 自测 |
 * | 宿主 → 界面 | `{type:'init', values, disabled, title, result}` | 初始状态 |
 * | 宿主 → 界面 | `{type:'set', values}` | 参数被外部修改（回滚、恢复草稿） |
 * | 宿主 → 界面 | `{type:'result', result}` | 最近一次运行的状态 |
 * | 宿主 → 界面 | `{type:'disabled', disabled}` | 只读状态变化 |
 */

/** 宿主推送给界面的运行状态。 */
export interface UiFrameResult {
  /** 'submit' 提交 / 'self-test' 自测 */
  kind: 'submit' | 'self-test';
  /** pending / judging / finished / error */
  status: string;
  /** 状态中文标签 */
  label: string;
  /** 总分（已换算，评测完成时有值） */
  score: number | null;
  /** 评测输出（自测时有值，已截断） */
  output?: string | null;
}

/**
 * 界面文档的 CSP：禁止一切网络请求（含 fetch / XHR / 表单 / 子框架），
 * 只允许内联脚本与样式，以及 data: 图片/字体/媒体。
 */
export const UI_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

/** 注入到界面里的 SDK（`window.NOJ`）。 */
const SDK = `(function () {
  var listeners = { init: [], set: [], result: [], disabled: [] };
  var state = { values: {}, inited: false, disabled: false, result: null, title: '' };
  function post(msg) {
    msg.source = 'noj-ui';
    parent.postMessage(msg, '*');
  }
  function fire(type, a, b) {
    for (var i = 0; i < listeners[type].length; i++) {
      try { listeners[type][i](a, b); } catch (e) { console.error(e); }
    }
  }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.source !== 'noj-host') return;
    if (d.type === 'init') {
      state.values = d.values || {}; state.disabled = !!d.disabled;
      state.result = d.result || null; state.title = d.title || ''; state.inited = true;
      fire('init', state.values, d);
    } else if (d.type === 'set') {
      state.values = d.values || {};
      fire('set', state.values);
    } else if (d.type === 'result') {
      state.result = d.result || null;
      fire('result', state.result);
    } else if (d.type === 'disabled') {
      state.disabled = !!d.disabled;
      fire('disabled', state.disabled);
    }
  });
  window.NOJ = {
    /** 当前参数（只读快照）。 */
    get values() { return state.values; },
    get disabled() { return state.disabled; },
    get result() { return state.result; },
    get title() { return state.title; },
    /** 界面就绪时回调（已就绪则立即回调）；参数为当前 values。 */
    onInit: function (fn) { listeners.init.push(fn); if (state.inited) fn(state.values, {}); },
    /** 参数被外部修改（如回滚到历史版本）时回调：界面应据此刷新控件。 */
    onSet: function (fn) { listeners.set.push(fn); },
    /** 最近一次自测/提交的状态变化时回调。 */
    onResult: function (fn) { listeners.result.push(fn); },
    onDisabled: function (fn) { listeners.disabled.push(fn); },
    /** 整份替换参数并通知宿主（合并更新请用 update）。 */
    setValues: function (values) { state.values = values || {}; post({ type: 'values', values: state.values }); },
    /** 合并更新部分字段并通知宿主。 */
    update: function (patch) {
      var next = {};
      for (var k in state.values) next[k] = state.values[k];
      for (var j in patch) next[j] = patch[j];
      window.NOJ.setValues(next);
    },
    /** 请求宿主提交评测 / 运行自测。 */
    submit: function () { post({ type: 'submit' }); },
    selfTest: function () { post({ type: 'self-test' }); }
  };
  post({ type: 'ready' });
})();`;

/**
 * 构造 iframe 的 `srcdoc`：CSP + SDK + 题包界面。
 *
 * 题包界面可以是完整文档也可以是片段——嵌入 `<body>` 后，其中的 `<style>` / `<script>`
 * 仍按 head 规则生效；SDK 放在最前面，保证界面脚本里 `window.NOJ` 已可用。
 */
export function buildUiFrameDoc(html: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${UI_FRAME_CSP}">` +
    `<script>${SDK}<\/script></head><body>` +
    html +
    '</body></html>'
  );
}

/** 顶层键排序后的稳定 JSON（历史对比与回滚的 diff 才不会因键序抖动）。 */
export function stableStringify(values: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(values).sort()) sorted[key] = values[key];
  return JSON.stringify(sorted, null, 2);
}

/** 解析宿主保存的参数文本；非对象/非法 JSON 一律视为空参数。 */
export function parseValues(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 两份参数是否等价（顶层键序无关）。 */
export function sameValues(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return stableStringify(a) === stableStringify(b);
}
