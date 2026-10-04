<script setup lang="ts">
// Markdown 分屏编辑器：左侧源码编辑，右侧 MarkdownRenderer 实时预览。
//
// - 三种视图：编辑 / 分屏 / 预览；窄屏（< md）分屏自动退化为上下堆叠
// - 工具栏与快捷键（Ctrl/⌘+B/I/K、Tab 缩进）调用 utils/markdownEditing 纯函数
// - 预览防抖渲染，避免长文档每次按键都重跑 KaTeX / highlight.js
// - 分屏时编辑区滚动按比例同步到预览区
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import MarkdownRenderer from '~/components/shared/MarkdownRenderer.vue';
import { type EditResult, insertBlock, insertText, prefixLines, wrapSelection } from '~/utils/markdownEditing';

type ViewMode = 'edit' | 'split' | 'preview';

const model = defineModel<string>({ default: '' });

const {
  placeholder = '支持 Markdown 语法与 $LaTeX$ 公式',
  height = '420px',
  maxlength,
  disabled = false,
  allowExternalImages = false,
  defaultMode = 'split',
} = defineProps<{
  placeholder?: string;
  /** 编辑/预览区高度（CSS 长度） */
  height?: string;
  maxlength?: number;
  disabled?: boolean;
  allowExternalImages?: boolean;
  defaultMode?: ViewMode;
}>();

const mode = ref<ViewMode>(defaultMode);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const previewRef = ref<HTMLElement | null>(null);

// ─── 防抖预览 ────────────────────────────────────────────────
const previewContent = ref(model.value);
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
watch(model, (v) => {
  clearTimeout(debounceTimer);
  // 非编辑可见时（纯预览）立即渲染；外部重置内容时也无需等待
  if (mode.value === 'preview') {
    previewContent.value = v;
    return;
  }
  debounceTimer = setTimeout(() => (previewContent.value = v), 200);
});
watch(mode, (m) => {
  if (m !== 'edit') {
    clearTimeout(debounceTimer);
    previewContent.value = model.value;
  }
});
onBeforeUnmount(() => clearTimeout(debounceTimer));

// ─── 编辑操作 ────────────────────────────────────────────────
function apply(fn: (text: string, start: number, end: number) => EditResult) {
  const el = textareaRef.value;
  if (!el || disabled) return;
  const result = fn(model.value, el.selectionStart, el.selectionEnd);
  if (maxlength && result.text.length > maxlength) return;
  model.value = result.text;
  nextTick(() => {
    el.focus();
    el.setSelectionRange(result.selectionStart, result.selectionEnd);
  });
}

interface ToolAction {
  icon: string;
  label: string;
  run: () => void;
}

const TOOLS: ToolAction[][] = [
  [
    { icon: 'i-lucide-heading', label: '标题', run: () => apply((t, s, e) => prefixLines(t, s, e, '## ')) },
    {
      icon: 'i-lucide-bold',
      label: '加粗（Ctrl+B）',
      run: () => apply((t, s, e) => wrapSelection(t, s, e, '**', '**', '粗体')),
    },
    {
      icon: 'i-lucide-italic',
      label: '斜体（Ctrl+I）',
      run: () => apply((t, s, e) => wrapSelection(t, s, e, '*', '*', '斜体')),
    },
    {
      icon: 'i-lucide-strikethrough',
      label: '删除线',
      run: () => apply((t, s, e) => wrapSelection(t, s, e, '~~', '~~', '删除')),
    },
  ],
  [
    { icon: 'i-lucide-quote', label: '引用', run: () => apply((t, s, e) => prefixLines(t, s, e, '> ')) },
    { icon: 'i-lucide-list', label: '无序列表', run: () => apply((t, s, e) => prefixLines(t, s, e, '- ')) },
    {
      icon: 'i-lucide-list-ordered',
      label: '有序列表',
      run: () => apply((t, s, e) => prefixLines(t, s, e, (i) => `${i + 1}. `)),
    },
    {
      icon: 'i-lucide-table',
      label: '表格',
      run: () => apply((t, s, e) => insertBlock(t, s, e, '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |', 2)),
    },
  ],
  [
    {
      icon: 'i-lucide-link',
      label: '链接（Ctrl+K）',
      run: () => apply((t, s, e) => wrapSelection(t, s, e, '[', '](https://)', '链接文字')),
    },
    {
      icon: 'i-lucide-image',
      label: '图片',
      run: () => apply((t, s, e) => wrapSelection(t, s, e, '![', '](https://)', '图片描述')),
    },
    {
      icon: 'i-lucide-code',
      label: '行内代码',
      run: () => apply((t, s, e) => wrapSelection(t, s, e, '`', '`', 'code')),
    },
    {
      icon: 'i-lucide-square-code',
      label: '代码块',
      run: () => apply((t, s, e) => insertBlock(t, s, e, '```python\n\n```', 10)),
    },
    {
      icon: 'i-lucide-sigma',
      label: '公式',
      run: () => apply((t, s, e) => insertBlock(t, s, e, '$$\n\n$$', 3)),
    },
  ],
];

const MODES: Array<{ value: ViewMode; label: string; icon: string }> = [
  { value: 'edit', label: '编辑', icon: 'i-lucide-pencil' },
  { value: 'split', label: '分屏', icon: 'i-lucide-columns-2' },
  { value: 'preview', label: '预览', icon: 'i-lucide-eye' },
];

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key === 'b') {
      e.preventDefault();
      apply((t, s, en) => wrapSelection(t, s, en, '**', '**', '粗体'));
    } else if (key === 'i') {
      e.preventDefault();
      apply((t, s, en) => wrapSelection(t, s, en, '*', '*', '斜体'));
    } else if (key === 'k') {
      e.preventDefault();
      apply((t, s, en) => wrapSelection(t, s, en, '[', '](https://)', '链接文字'));
    }
    return;
  }
  // Tab 插入两个空格（Shift+Tab 保留浏览器默认的焦点切换，保证键盘可达性）
  if (e.key === 'Tab' && !e.shiftKey && !mod && !e.altKey) {
    e.preventDefault();
    apply((t, s, en) => insertText(t, s, en, '  '));
  }
}

// ─── 滚动同步（编辑 → 预览，按比例） ───────────────────────────
function onEditorScroll() {
  if (mode.value !== 'split') return;
  const src = textareaRef.value;
  const dst = previewRef.value;
  if (!src || !dst) return;
  const srcMax = src.scrollHeight - src.clientHeight;
  const dstMax = dst.scrollHeight - dst.clientHeight;
  if (srcMax <= 0 || dstMax <= 0) return;
  dst.scrollTop = (src.scrollTop / srcMax) * dstMax;
}

const charCount = computed(() => model.value.length);
</script>

<template>
  <div class="markdown-editor flex flex-col rounded-md border border-border bg-bg-panel overflow-hidden">
    <!-- 工具栏 -->
    <div class="flex flex-wrap items-center gap-1 px-2 py-1.5 border-b border-border bg-bg-sunken">
      <template v-for="(group, gi) in TOOLS" :key="gi">
        <span v-if="gi > 0" class="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <button
          v-for="tool in group"
          :key="tool.icon"
          type="button"
          class="inline-flex size-7 items-center justify-center rounded text-text-secondary transition-colors hover:bg-bg-panel hover:text-text disabled:opacity-40 disabled:pointer-events-none"
          :title="tool.label"
          :aria-label="tool.label"
          :disabled="disabled || mode === 'preview'"
          @click="tool.run"
        >
          <UIcon :name="tool.icon" class="size-4" />
        </button>
      </template>

      <div class="ml-auto flex items-center rounded border border-border bg-bg-panel p-0.5" role="tablist">
        <button
          v-for="m in MODES"
          :key="m.value"
          type="button"
          role="tab"
          :aria-selected="mode === m.value"
          class="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs transition-colors"
          :class="mode === m.value ? 'bg-primary text-white' : 'text-text-secondary hover:text-text'"
          @click="mode = m.value"
        >
          <UIcon :name="m.icon" class="size-3.5" />
          {{ m.label }}
        </button>
      </div>
    </div>

    <!-- 编辑 / 预览区 -->
    <div
      class="grid min-h-0"
      :class="mode === 'split' ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'"
    >
      <textarea
        v-show="mode !== 'preview'"
        ref="textareaRef"
        v-model="model"
        :placeholder="placeholder"
        :maxlength="maxlength"
        :disabled="disabled"
        spellcheck="false"
        class="block w-full resize-none bg-transparent px-3 py-3 font-mono text-sm leading-relaxed text-text outline-none disabled:opacity-60"
        :class="mode === 'split' ? 'border-b border-border md:border-b-0 md:border-r' : ''"
        :style="{ height }"
        @keydown="onKeydown"
        @scroll="onEditorScroll"
      />
      <div
        v-if="mode !== 'edit'"
        ref="previewRef"
        class="overflow-y-auto px-4 py-3"
        :style="{ height }"
      >
        <MarkdownRenderer
          v-if="previewContent.trim()"
          :content="previewContent"
          :allow-external-images="allowExternalImages"
        />
        <p v-else class="text-xs text-text-muted">暂无内容</p>
      </div>
    </div>

    <!-- 状态栏 -->
    <div class="flex items-center justify-between gap-2 px-3 py-1 border-t border-border bg-bg-sunken text-[11px] text-text-muted">
      <span>Markdown · $行内公式$ · $$块级公式$$</span>
      <span class="tabular-nums">{{ charCount }}<template v-if="maxlength"> / {{ maxlength }}</template> 字符</span>
    </div>
  </div>
</template>
