/**
 * noj-ui 设计系统守卫：七条规则的匹配与命中计数。
 *
 * 与门禁入口（`scripts/check-ui-guards.ts`）分离，让单测能直接对着规则本身
 * 断言——规则写坏时门禁会安静地锁出一份"零命中"的假基线，之后任何回流都拦不住。
 */

/** 规则名（顺序即报告与基线的列顺序）。 */
export type RuleName =
  | "radius"
  | "palette"
  | "motion"
  | "entrance"
  | "dark"
  | "raw-control"
  | "type";

export const RULE_NAMES: readonly RuleName[] = [
  "radius",
  "palette",
  "motion",
  "entrance",
  "dark",
  "raw-control",
  "type",
];

/**
 * 每条规则的匹配模式。
 *
 * **不含 `g` 标志**：计数时统一重建带 `g` 的实例，避免 `lastIndex` 串状态。
 * `raw-control` 要读标签属性判断 input 类型，不用本表，由 `countRawControls` 处理。
 */
const PATTERNS: Record<Exclude<RuleName, "raw-control">, readonly RegExp[]> = {
  // 设计系统只允许 `rounded` / `rounded-md` / `rounded-full`（4px 工业圆角）。
  radius: [
    /rounded-(?:lg|xl|2xl|3xl)(?![\w-])/,
    /rounded-\[[^\]\n]*\]/,
  ],
  // Tailwind 原始色板：颜色只能来自 --c-* token（AGENTS.md 禁令 9）。
  palette: [
    /(?<![\w-])(?:bg|text|border|divide|ring|outline|from|via|to|fill|stroke|accent|placeholder|caret)-(?:blue|sky|green|emerald|red|rose|amber|yellow|gray|slate|zinc|purple|indigo|pink|orange|teal|cyan|lime|violet|fuchsia)-\d{2,3}(?![\w-])/,
  ],
  motion: [
    /animate-ping/,
    // 不加前导边界：`group-hover:-translate-y-*` 是同一类悬停位移，也要拦。
    /hover:-translate-y/,
    /transition-all/,
  ],
  // 任意值入场动画：`animate-[fadeInUp_0.5s_ease_both]`。
  entrance: [/animate-\[[^\]\n]*\]/],
  // 类名里的 `dark:` 变体。`(?<![\w-])` 排除 CSS 变量 `--c-bg-dark:` 一类写法。
  dark: [/(?<![\w-])dark:/],
  // 手写字号：`text-13px` / `text-[14px]`；`text-[#e6edf3]` 是颜色，不算。
  type: [
    /text-(?:11|13|15|17|22|28)px(?![\w-])/,
    /text-\[[^\]\n]*px\]/,
  ],
};

/** 非文本类 input：由 UCheckbox / URadio / UFileInput 等组件承担，不算违规。 */
const NON_TEXT_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "file",
  "range",
  "color",
  "hidden",
  "submit",
  "reset",
  "button",
  "image",
]);

/** `source[start]` 处的 `<` 对应的标签文本（正确处理引号里的 `>`）。 */
function tagTextAt(source: string, start: number): string {
  let quote = "";
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return source.slice(start, i);
  }
  return source.slice(start);
}

/** 原生控件：`<button>` / 文本类 `<input>` / `<select>` / `<textarea>`。 */
function countRawControls(source: string): number {
  let count = 0;
  for (
    const match of source.matchAll(
      /<(button|input|select|textarea)(?=[\s>/])/gi,
    )
  ) {
    if (match[1].toLowerCase() === "input") {
      // 静态 `type="checkbox"` 之类不算；缺省 type 与动态绑定保守按文本类计。
      const type = /\s:?type\s*=\s*(["'])([^"']*)\1/i.exec(
        tagTextAt(source, match.index ?? 0),
      );
      if (type && NON_TEXT_INPUT_TYPES.has(type[2].toLowerCase())) continue;
    }
    count++;
  }
  return count;
}

/** 抹掉 HTML 注释（保留换行与总长度）：注释里贴的示例代码不该算违规。 */
function stripHtmlComments(source: string): string {
  return source.replace(
    /<!--[\s\S]*?-->/g,
    (block) => block.replace(/[^\n]/g, " "),
  );
}

/** 累计一组模式在源码中的命中次数。 */
function countAll(source: string, patterns: readonly RegExp[]): number {
  let total = 0;
  for (const pattern of patterns) {
    total += [...source.matchAll(new RegExp(pattern.source, "g"))].length;
  }
  return total;
}

function countRule(rule: RuleName, source: string): number {
  if (rule === "raw-control") return countRawControls(source);
  return countAll(source, PATTERNS[rule]);
}

/** 全零计数表（键顺序 = RULE_NAMES）。 */
export function zeroCounts(): Record<RuleName, number> {
  const counts = {} as Record<RuleName, number>;
  for (const rule of RULE_NAMES) counts[rule] = 0;
  return counts;
}

/** 统计单个 `.vue` 源码里七条规则的命中次数。 */
export function detect(source: string): Record<RuleName, number> {
  const code = stripHtmlComments(source);
  const counts = zeroCounts();
  for (const rule of RULE_NAMES) counts[rule] = countRule(rule, code);
  return counts;
}

/**
 * 内置探针：七类违规各来一次，外加故意不命中的反例（CSS 变量、非文本
 * input、注释里的标签、颜色任意值）。规则写坏时这里会先红。
 */
export const PROBE_SOURCE = `<template>
  <div class="rounded-xl rounded-2xl rounded-[7px] bg-blue-500 text-slate-700
              animate-ping hover:-translate-y-1 transition-all
              animate-[fadeIn_1s_ease] dark:bg-bg-panel text-13px text-[14px]">
    <button>原生按钮</button>
    <input type="text" />
    <select><option>a</option></select>
    <textarea />
    <input type="checkbox" />
    <!-- <button>注释里的按钮不算</button> -->
  </div>
</template>
<style>
  :root { --c-bg-dark: #0b0f19; }
  .x { color: var(--c-bg-dark); }
</style>
`;

/** 探针的期望命中数：逐条锁定，防止"多算"悄悄推高基线。 */
export const PROBE_EXPECTED: Record<RuleName, number> = {
  radius: 3,
  palette: 2,
  motion: 3,
  entrance: 1,
  dark: 1,
  "raw-control": 4,
  type: 2,
};

/** 探针校验：任一规则命中数与期望不符即报错。 */
export function verifyProbe(): string[] {
  const actual = detect(PROBE_SOURCE);
  const errors: string[] = [];
  for (const rule of RULE_NAMES) {
    if (actual[rule] !== PROBE_EXPECTED[rule]) {
      errors.push(
        `内置探针在规则 ${rule} 上命中 ${actual[rule]} 次` +
          `（期望 ${PROBE_EXPECTED[rule]}）——该规则已失效`,
      );
    }
  }
  return errors;
}
