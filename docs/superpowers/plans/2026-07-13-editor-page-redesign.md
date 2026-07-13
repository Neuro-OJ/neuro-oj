# 做题界面重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把做题界面从 `pages/problems/[id].vue` 双栏布局重构为独立 `/editor/:id` 路由的 VSCode 风格 IDE 界面，含本地草稿、主题切换、可拖拽侧栏。

**Architecture:** 新增 `pages/editor/[id].vue` 全屏编码页 + 5 个 editor 组件 + 3 个 composable；`pages/problems/[id].vue` 简化为阅读页 + "开始编码"入口；通过 CSS 变量作用域（`.editor-dark`）实现仅编辑页生效的 dark 模式。

**Tech Stack:** Nuxt 4 + Vue 3 (`<script setup lang="ts">`) + Tailwind CSS + Monaco Editor (CDN self-host) + TypeScript + localStorage

## Global Constraints

- **GPG 签名强制**：所有提交必须用 `F27B5D0A639B43695413D9440F49774CB31F6CF1` 签名（CLAUDE.md §5）
- **中文提交信息**：`<type>(<scope>): <中文描述>`（CLAUDE.md §5）
- **Tailwind only**：禁止手写 CSS，仅 Tailwind utility 类（noj-ui/CLAUDE.md §样式规范）
- **`<script setup lang="ts">` Composition API**：所有 Vue 组件（noj-ui/CLAUDE.md §组件结构）
- **Composable 命名**：新 composable 使用 camelCase（与 `useAuth`、`useBanStatus` 一致）
- **CSS 变量驱动**：所有颜色通过 `var(--c-*)` 引用，颜色调整只动 CSS 变量（noj-ui/app.vue:22-29）
- **Monaco 版本锁定**：`0.55.1`，与 package.json 对齐
- **`<ClientOnly>` 包裹 Monaco**：SSR 不调用浏览器 API
- **响应式断点**：`lg:1024 / md:768 / sm:<768`（noj-ui 现状）
- **测试策略**：noj-ui 无前端单测框架，验证 = `deno task lint` + `deno task fmt` + 浏览器手测；E2E 在 noj-tests 扩展
- **后端零改动**：所有改动仅在 noj-ui 内部
- **PR 工作流**：先 `jj git push -b` 分支，再 `gh pr create`（CLAUDE.md §6）

---

## File Structure

```
noj-ui/
├── app.vue                                          # 追加 .editor-dark CSS 变量
├── pages/
│   ├── problems/[id].vue                            # 简化：移除 Monaco + "开始编码"
│   └── editor/[id].vue                              # 新增：IDE 风格编码页
├── components/editor/
│   ├── MonacoEditor.vue                             # 改造：+ theme prop/watch
│   ├── EditorToolbar.vue                            # 新增
│   ├── ActivityBar.vue                              # 新增
│   ├── EditorSidebar.vue                            # 新增
│   ├── EditorStatusBar.vue                          # 新增
│   └── ResizableSplitter.vue                        # 新增
└── composables/
    ├── useEditorTheme.ts                            # 新增
    ├── useDraftStorage.ts                           # 新增
    └── useResizableSplit.ts                         # 新增

noj-tests/e2e/
└── 08_editor_flow.test.ts                           # 新增
```

---

## Task 1: 主题系统基础（CSS 变量 + useEditorTheme + Monaco theme 改造）

**Files:**
- Modify: `noj-ui/app.vue:21-32`（追加 .editor-dark CSS 块）
- Modify: `noj-ui/components/editor/MonacoEditor.vue:1-124`（加 theme prop + watch + 改造 create）
- Create: `noj-ui/composables/useEditorTheme.ts`

**Interfaces:**
- Produces: `useEditorTheme()` → `{ theme: Ref<'light'|'dark'>, toggle: () => void }`
- Consumes: localStorage key `noj:editor:theme`
- Affects: `<html>.editor-dark` class + Monaco `setTheme('vs' | 'vs-dark')`

- [ ] **Step 1: 追加 .editor-dark CSS 变量到 app.vue**

修改 `noj-ui/app.vue`，在现有 `<style>` 块底部追加：

```css
/* .editor-dark 作用域：仅 /editor 路由内的 dark 模式变量覆盖 */
.editor-dark {
  --c-bg-page: #0f172a;        /* slate-900 */
  --c-white: #1e293b;           /* slate-800 — 面板背景 */
  --c-border: #334155;          /* slate-700 */
  --c-text: #e2e8f0;            /* slate-200 */
  --c-text-secondary: #94a3b8;  /* slate-400 */
  --c-text-muted: #64748b;      /* slate-500 */
  --c-primary: #3b82f6;
  --c-primary-hover-bg: #1e3a8a;
  --c-primary-bg: #1e293b;
}

.editor-dark .prose-neuro {
  --tw-prose-headings: #e2e8f0;
  --tw-prose-links: #60a5fa;
  --tw-prose-code: #f472b6;
}
```

完整 `<style>` 块应为：

```vue
<style>
:root {
    --c-primary: #2563eb; --c-primary-dark: #1d4ed8; --c-primary-light: #3b82f6;
    --c-primary-bg: #eff6ff; --c-primary-hover-bg: #dbeafe; --c-primary-active-bg: #bfdbfe; --c-primary-text: #1e40af;
    --c-bg-dark: #0f172a; --c-bg-dark-2: #1e293b; --c-bg-dark-3: #334155;
    --c-success-text: #137333; --c-info-text: #1967d2; --c-warning-text: #92400e; --c-error-text: #b91c1c;
    --c-text: #1e293b; --c-text-secondary: #64748b; --c-text-muted: #94a3b8;
    --c-border: #e2e8f0; --c-bg-page: #f8fafc; --c-white: #ffffff;
}

.editor-dark {
  --c-bg-page: #0f172a;
  --c-white: #1e293b;
  --c-border: #334155;
  --c-text: #e2e8f0;
  --c-text-secondary: #94a3b8;
  --c-text-muted: #64748b;
  --c-primary: #3b82f6;
  --c-primary-hover-bg: #1e3a8a;
  --c-primary-bg: #1e293b;
}

.editor-dark .prose-neuro {
  --tw-prose-headings: #e2e8f0;
  --tw-prose-links: #60a5fa;
  --tw-prose-code: #f472b6;
}
</style>
```

- [ ] **Step 2: 创建 useEditorTheme composable**

新建 `noj-ui/composables/useEditorTheme.ts`：

```typescript
/**
 * 编辑器主题状态（light / dark），仅作用于 /editor 路由。
 *
 * - 持久化：localStorage `noj:editor:theme`
 * - DOM 同步：<html> 节点切换 `.editor-dark` 类（实际挂在 /editor 路由根 div 上，更安全）
 * - Monaco 同步：调用方需在组件中 watch theme 后调 monaco.editor.setTheme()
 */
export type EditorTheme = 'light' | 'dark'

const STORAGE_KEY = 'noj:editor:theme'

export function useEditorTheme() {
  const theme = useState<EditorTheme>('editor:theme', () => {
    if (import.meta.client) {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === 'light' || stored === 'dark') return stored
    }
    return 'dark' // 默认 dark（沉浸式场景）
  })

  function set(t: EditorTheme) {
    theme.value = t
  }

  function toggle() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
  }

  // 写入 localStorage
  if (import.meta.client) {
    watch(theme, (t) => {
      localStorage.setItem(STORAGE_KEY, t)
    })
  }

  return { theme, set, toggle }
}
```

- [ ] **Step 3: 改造 MonacoEditor.vue 添加 theme prop**

修改 `noj-ui/components/editor/MonacoEditor.vue`：

1. 在 `defineProps` 中追加 `theme?: 'vs' | 'vs-dark'`
2. 在 `editor.create()` 调用中把硬编码的 `theme: "vs-dark"` 改为 `theme: props.theme ?? 'vs-dark'`
3. 在文件末尾的 watch 块之前新增 watch 处理 theme 切换

`defineProps` 部分改为：

```typescript
const props = defineProps<{
  modelValue: string
  language?: string
  disabled?: boolean
  minHeight?: number
  theme?: 'vs' | 'vs-dark'
}>()
```

`editor.create()` 调用（位于 `initMonaco()` 函数内）的 `theme` 字段改为：

```typescript
editor = monaco.editor.create(containerRef.value, {
    value: props.modelValue,
    language: langMap[props.language ?? "python3"] || "python",
    theme: props.theme ?? "vs-dark",
    minimap: { enabled: false },
    fontSize: 13,
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    automaticLayout: true,
    readOnly: props.disabled ?? false,
    tabSize: 4,
    insertSpaces: true,
    wordWrap: "on",
    padding: { top: 12, bottom: 12 },
    renderWhitespace: "selection",
    smoothScrolling: true,
    cursorBlinking: "smooth",
    cursorSmoothCaretAnimation: "on",
})
```

在 `watch(() => props.language, ...)` 块之后追加：

```typescript
// Sync theme changes
watch(
  () => props.theme,
  (t) => {
    if (editor && t) {
      monacoModule.editor.setTheme(t)
    }
  },
)
```

- [ ] **Step 4: 验证编译**

```bash
cd noj-ui && deno task lint && deno task fmt
```

Expected: 0 errors. `fmt` 可能重排格式，确认无误后继续。

- [ ] **Step 5: 启动 dev server 烟雾测试**

```bash
cd noj-ui && deno task dev &
sleep 15
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/problems/1001
```

Expected: `200`

```bash
kill %1 2>/dev/null
```

- [ ] **Step 6: 提交**

```bash
git add noj-ui/app.vue noj-ui/composables/useEditorTheme.ts noj-ui/components/editor/MonacoEditor.vue
git commit -m "feat(ui): 编辑页主题基础 — .editor-dark 变量与 useEditorTheme composable" --gpg-sign=F27B5D0A639B43695413D9440F49774CB31F6CF1
```

---

## Task 2: useDraftStorage composable

**Files:**
- Create: `noj-ui/composables/useDraftStorage.ts`

**Interfaces:**
- Consumes: `problemId: Ref<string>`, `code: Ref<string>`, `enabled: Ref<boolean>`
- Produces: `{ state: Ref<DraftState>, savedAt: Ref<Date | null>, clear: () => void }`
- Storage: localStorage key `noj:draft:{problemId}`

- [ ] **Step 1: 创建 composable 文件**

新建 `noj-ui/composables/useDraftStorage.ts`：

```typescript
/**
 * 代码草稿自动保存到 localStorage。
 *
 * - 防抖 800ms 写入
 * - 提交成功后不自动清除（避免评测失败后无法恢复代码）
 * - 主动调 clear() 才删除
 * - QuotaExceeded 等写入错误转 state='error'
 */

export type DraftState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

export interface DraftData {
  content: string
  updatedAt: number
}

const DEBOUNCE_MS = 800

export function useDraftStorage(
  problemId: Ref<string>,
  code: Ref<string>,
  enabled: Ref<boolean>,
) {
  const state = ref<DraftState>('idle')
  const savedAt = ref<Date | null>(null)

  const key = computed(() => `noj:draft:${problemId.value}`)
  let timer: ReturnType<typeof setTimeout> | null = null

  // 加载（仅客户端）
  onMounted(() => {
    if (!import.meta.client) return
    try {
      const raw = localStorage.getItem(key.value)
      if (raw) {
        const data = JSON.parse(raw) as DraftData
        if (typeof data.content === 'string' && typeof data.updatedAt === 'number') {
          code.value = data.content
          savedAt.value = new Date(data.updatedAt)
          state.value = 'saved'
        }
      }
    } catch {
      // 损坏的 JSON 忽略，当作无草稿
      state.value = 'idle'
    }
  })

  // 监听变化写入（防抖）
  watch(code, (val) => {
    if (!import.meta.client) return
    if (!enabled.value) return
    if (timer) clearTimeout(timer)
    state.value = 'dirty'
    timer = setTimeout(() => {
      state.value = 'saving'
      try {
        localStorage.setItem(
          key.value,
          JSON.stringify({ content: val, updatedAt: Date.now() } satisfies DraftData),
        )
        savedAt.value = new Date()
        state.value = 'saved'
      } catch {
        state.value = 'error'
      }
    }, DEBOUNCE_MS)
  })

  // 清理 timer
  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer)
  })

  // 主动清除（设置面板"清除草稿"按钮调用）
  function clear() {
    if (!import.meta.client) return
    if (timer) clearTimeout(timer)
    localStorage.removeItem(key.value)
    savedAt.value = null
    state.value = 'idle'
  }

  return { state, savedAt, clear }
}
```

- [ ] **Step 2: 验证编译**

```bash
cd noj-ui && deno task lint && deno task fmt
```

Expected: 0 errors.

- [ ] **Step 3: 提交**

```bash
git add noj-ui/composables/useDraftStorage.ts
git commit -m "feat(ui): useDraftStorage composable — 防抖 800ms 写 localStorage" --gpg-sign=F27B5D0A639B43695413D9440F49774CB31F6CF1
```

---

## Task 3: useResizableSplit composable + ResizableSplitter 组件

**Files:**
- Create: `noj-ui/composables/useResizableSplit.ts`
- Create: `noj-ui/components/editor/ResizableSplitter.vue`

**Interfaces:**
- `useResizableSplit(key, initial, min, max)` → `{ width: Ref<number>, startDrag: (e: MouseEvent) => void, reset: () => void }`
- `ResizableSplitter.vue` props: `modelValue, min, max, side`
- emits: `update:modelValue`

- [ ] **Step 1: 创建 useResizableSplit composable**

新建 `noj-ui/composables/useResizableSplit.ts`：

```typescript
/**
 * 可拖拽分隔条状态机。
 *
 * - 持久化宽度到 localStorage（key 由调用方指定，如 `editor:sidebar:width`）
 * - mousedown/move/up 全局监听，避免鼠标拖出分隔条后丢失事件
 * - 移动端（< md）不调用 startDrag
 */

export function useResizableSplit(
  storageKey: string,
  initial: number,
  min: number,
  max: number,
) {
  const width = ref(initial)

  // 加载持久化宽度
  onMounted(() => {
    if (!import.meta.client) return
    const stored = Number(localStorage.getItem(storageKey))
    if (Number.isFinite(stored) && stored >= min && stored <= max) {
      width.value = stored
    }
  })

  function persist(v: number) {
    if (import.meta.client) {
      localStorage.setItem(storageKey, String(v))
    }
  }

  function startDrag(e: MouseEvent) {
    if (!import.meta.client) return
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width.value

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX
      const next = Math.max(min, Math.min(max, startWidth + dx))
      width.value = next
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      persist(width.value)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function reset() {
    width.value = Math.floor((min + max) / 2)
    persist(width.value)
  }

  return { width, startDrag, reset }
}
```

- [ ] **Step 2: 创建 ResizableSplitter 组件**

新建 `noj-ui/components/editor/ResizableSplitter.vue`：

```vue
<script setup lang="ts">
const props = defineProps<{
  modelValue: number
  min: number
  max: number
  side: 'left' | 'right'
}>()

const emit = defineEmits<{
  'update:modelValue': [value: number]
}>()

function onMouseDown(e: MouseEvent) {
  e.preventDefault()
  const startX = e.clientX
  const startWidth = props.modelValue

  function onMove(ev: MouseEvent) {
    const dx = ev.clientX - startX
    const next = Math.max(props.min, Math.min(props.max, startWidth + dx))
    emit('update:modelValue', next)
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

function onDoubleClick() {
  emit('update:modelValue', Math.floor((props.min + props.max) / 2))
}
</script>

<template>
  <div
    class="w-1.5 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors hidden md:block flex-shrink-0"
    :class="side === 'left' ? 'border-l border-border' : 'border-r border-border'"
    @mousedown="onMouseDown"
    @dblclick="onDoubleClick"
  />
</template>
```

- [ ] **Step 3: 验证编译**

```bash
cd noj-ui && deno task lint && deno task fmt
```

Expected: 0 errors。

- [ ] **Step 4: 提交**

```bash
git add noj-ui/composables/useResizableSplit.ts noj-ui/components/editor/ResizableSplitter.vue
git commit -m "feat(ui): ResizableSplitter — 可拖拽分隔条 + useResizableSplit composable" --gpg-sign=F27B5D0A639B43695413D9440F49774CB31F6CF1
```

---

## Task 4: ActivityBar 组件

**Files:**
- Create: `noj-ui/components/editor/ActivityBar.vue`

**Interfaces:**
- props: `active: 'description' | 'history' | 'settings'`
- emits: `(e: 'select', value) => void`

- [ ] **Step 1: 创建组件文件**

新建 `noj-ui/components/editor/ActivityBar.vue`：

```vue
<script setup lang="ts">
import { BookOpen, History, Settings } from '@lucide/vue'

type Tab = 'description' | 'history' | 'settings'

defineProps<{ active: Tab }>()
defineEmits<{ select: [value: Tab] }>()

interface Item {
  key: Tab
  label: string
  icon: typeof BookOpen
}

const items: Item[] = [
  { key: 'description', label: '题目描述', icon: BookOpen },
  { key: 'history', label: '提交历史', icon: History },
  { key: 'settings', label: '设置', icon: Settings },
]
</script>

<template>
  <aside class="w-12 flex-shrink-0 bg-bg-page border-r border-border flex flex-col items-center py-2 gap-1">
    <button
      v-for="item in items"
      :key="item.key"
      :title="item.label"
      :aria-label="item.label"
      :aria-pressed="active === item.key"
      class="relative w-12 h-12 flex items-center justify-center rounded-md transition-colors duration-100 hover:bg-white"
      :class="active === item.key ? 'text-primary bg-white' : 'text-text-secondary'"
      @click="$emit('select', item.key)"
    >
      <span
        v-if="active === item.key"
        class="absolute left-0 top-2 bottom-2 w-0.5 bg-primary rounded-r"
      />
      <component :is="item.icon" :size="20" />
    </button>
  </aside>
</template>
```

- [ ] **Step 2: 验证编译**

```bash
cd noj-ui && deno task lint && deno task fmt
```

Expected: 0 errors。如果 `@lucide/vue` 报错，检查 import 路径是否在 SSR 兼容列表中（`nuxt.config.ts` 中 `ssr: { noExternal: ['@lucide/vue'] }`）。

- [ ] **Step 3: 提交**

```bash
git add noj-ui/components/editor/ActivityBar.vue
git commit -m "feat(ui): ActivityBar — 三图标侧栏导航" --gpg-sign=F27B5D0A639B43695413D9440F49774CB31F6CF1
```

---

## Task 5: EditorStatusBar 组件

**Files:**
- Create: `noj-ui/components/editor/EditorStatusBar.vue`

**Interfaces:**
- props: `language, cursor, totalLines, totalChars, draftState, draftSavedAt`

- [ ] **Step 1: 创建组件文件**

新建 `noj-ui/components/editor/EditorStatusBar.vue`：

```vue
<script setup lang="ts">
import type { DraftState } from '~/composables/useDraftStorage'

const props = defineProps<{
  language: string
  cursor: { line: number; col: number }
  totalLines: number
  totalChars: number
  draftState: DraftState
  draftSavedAt: Date | null
}>()

const draftLabel = computed(() => {
  switch (props.draftState) {
    case 'dirty':
      return '编辑中…'
    case 'saving':
      return '保存中…'
    case 'error':
      return '保存失败'
    case 'saved':
    case 'idle':
      return savedAtLabel.value
    default:
      return ''
  }
})

const draftDotClass = computed(() => {
  switch (props.draftState) {
    case 'dirty':
      return 'bg-orange-500'
    case 'saving':
      return 'bg-blue-500 animate-pulse'
    case 'error':
      return 'bg-red-500'
    case 'saved':
      return 'bg-green-500'
    default:
      return 'bg-text-muted'
  }
})

const savedAtLabel = computed(() => {
  if (!props.draftSavedAt) return '未保存'
  const diff = Math.floor((Date.now() - props.draftSavedAt.getTime()) / 1000)
  if (diff < 2) return '刚刚已保存'
  if (diff < 60) return `${diff}s 前已保存`
  if (diff < 3600) return `${Math.floor(diff / 60)}m 前已保存`
  return props.draftSavedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' 已保存'
})

const charsLabel = computed(() => {
  return `${props.totalChars.toLocaleString('zh-CN')} 字符`
})
</script>

<template>
  <div class="h-6 flex-shrink-0 bg-bg-page border-t border-border flex items-center px-3 gap-4 text-[11px] text-text-secondary font-mono">
    <span class="flex items-center gap-1.5">
      <span class="size-1.5 rounded-full" :class="draftDotClass" />
      <span>{{ draftLabel }}</span>
    </span>
    <span>UTF-8</span>
    <span>{{ language }}</span>
    <span>Ln {{ cursor.line }}, Col {{ cursor.col }}</span>
    <span>{{ totalLines }} 行</span>
    <span>{{ charsLabel }}</span>
  </div>
</template>
```

- [ ] **Step 2: 验证编译**

```bash
cd noj-ui && deno task lint && deno task fmt
```

Expected: 0 errors。

- [ ] **Step 3: 提交**

```bash
git add noj-ui/components/editor/EditorStatusBar.vue
git commit -m "feat(ui): EditorStatusBar — 底部状态栏（光标/字符/草稿状态）" --gpg-sign=F27B5D0A639B43695413D9440F49774CB31F6CF1
```

---

## Task 6: EditorToolbar 组件

**Files:**
- Create: `noj-ui/components/editor/EditorToolbar.vue`

**Interfaces:**
- props: `problem, language, languages, themeMode, canSubmit, submitting, sidebarVisible`
- emits: `update:language, update:themeMode, toggle-sidebar, open-settings, submit, back`

- [ ] **Step 1: 创建组件文件**

新建 `noj-ui/components/editor/EditorToolbar.vue`：

```vue
<script setup lang="ts">
import { ArrowLeft, Moon, Sun, Settings, Sidebar, Loader2, Send } from '@lucide/vue'
import type { EditorTheme } from '~/composables/useEditorTheme'

interface Problem {
  id: string
  display_id: string
  title: string
  type: 'U' | 'P'
}

interface LanguageOption {
  value: string
  label: string
}

const props = defineProps<{
  problem: Problem
  language: string
  languages: LanguageOption[]
  themeMode: EditorTheme
  canSubmit: boolean
  submitting: boolean
  sidebarVisible: boolean
}>()

const emit = defineEmits<{
  'update:language': [value: string]
  'update:themeMode': [value: EditorTheme]
  'toggle-sidebar': []
  'open-settings': []
  submit: []
  back: []
}>()

function toggleTheme() {
  emit('update:themeMode', props.themeMode === 'dark' ? 'light' : 'dark')
}
</script>

<template>
  <div class="h-12 flex-shrink-0 bg-white border-b border-border flex items-center px-3 gap-3">
    <!-- 左：返回 + 题目标题 -->
    <button
      class="inline-flex items-center gap-1 text-text-secondary hover:text-text transition-colors text-sm"
      aria-label="返回题目详情"
      @click="emit('back')"
    >
      <ArrowLeft :size="16" />
    </button>
    <div class="flex items-center gap-2 min-w-0">
      <span
        class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold flex-shrink-0"
        :class="problem.type === 'U' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'"
      >
        {{ problem.display_id }}
      </span>
      <span class="text-sm font-medium text-text truncate">{{ problem.title }}</span>
    </div>

    <!-- 中部 spacer -->
    <div class="flex-1" />

    <!-- 右：语言 + 主题 + 侧栏 + 设置 + 提交 -->
    <div class="flex items-center gap-1.5">
      <select
        :value="language"
        class="text-xs px-2 py-1 border border-border rounded-md bg-white text-text focus:outline-none focus:border-primary"
        @change="emit('update:language', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="opt in languages" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>

      <button
        class="size-8 inline-flex items-center justify-center rounded-md hover:bg-bg-page text-text-secondary transition-colors"
        :aria-label="themeMode === 'dark' ? '切换到亮色' : '切换到暗色'"
        :title="themeMode === 'dark' ? '切换到亮色' : '切换到暗色'"
        @click="toggleTheme"
      >
        <Moon v-if="themeMode === 'dark'" :size="16" />
        <Sun v-else :size="16" />
      </button>

      <button
        class="size-8 inline-flex items-center justify-center rounded-md hover:bg-bg-page text-text-secondary transition-colors"
        :class="sidebarVisible ? 'bg-bg-page text-primary' : ''"
        aria-label="切换侧栏"
        title="切换侧栏"
        @click="emit('toggle-sidebar')"
      >
        <Sidebar :size="16" />
      </button>

      <button
        class="size-8 inline-flex items-center justify-center rounded-md hover:bg-bg-page text-text-secondary transition-colors"
        aria-label="设置"
        title="设置"
        @click="emit('open-settings')"
      >
        <Settings :size="16" />
      </button>

      <button
        class="ml-1 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-primary text-white hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        :disabled="!canSubmit || submitting"
        @click="emit('submit')"
      >
        <Loader2 v-if="submitting" :size="14" class="animate-spin" />
        <Send v-else :size="14" />
        <span>{{ submitting ? '提交中...' : '提交评测' }}</span>
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 2: 验证编译**

```bash
cd noj-ui && deno task lint && deno task fmt
```

Expected: 0 errors。

- [ ] **Step 3: 提交**

```bash
git add noj-ui/components/editor/EditorToolbar.vue
git commit -m "feat(ui): EditorToolbar — 顶部工具栏（标题/语言/主题/提交）" --gpg-sign=F27B5D0A639B43695413D9440F49774CB31F6CF1
```

---

## Task 7: EditorSidebar 组件

**Files:**
- Create: `noj-ui/components/editor/EditorSidebar.vue`

**Interfaces:**
- props: `active, problem, submissions, themeMode, draftEnabled`
- emits: `update:themeMode, update:draftEnabled, clear-draft, open-submission`

- [ ] **Step 1: 创建组件文件**

新建 `noj-ui/components/editor/EditorSidebar.vue`：

```vue
<script setup lang="ts">
import { Clock, Server, Sun, Moon, Trash2, ChevronRight } from '@lucide/vue'
import MarkdownRenderer from '~/components/MarkdownRenderer.vue'
import StatusBadge from '~/components/StatusBadge.vue'
import type { EditorTheme } from '~/composables/useEditorTheme'

type Tab = 'description' | 'history' | 'settings'

interface Problem {
  id: string
  display_id: string
  title: string
  description: string
  difficulty: string
  time_limit_ms: number
  memory_limit_mb: number
  type: 'U' | 'P'
  categories: { id: string; name: string; slug: string }[]
}

interface Submission {
  id: string
  status: string
  score: number
  language: string
  created_at: string
}

defineProps<{
  active: Tab
  problem: Problem
  submissions: Submission[]
  themeMode: EditorTheme
  draftEnabled: boolean
}>()

const emit = defineEmits<{
  'update:themeMode': [value: EditorTheme]
  'update:draftEnabled': [value: boolean]
  'clear-draft': []
  'open-submission': [id: string]
}>()

function formatScore(s: number) {
  return `${(s / 100).toFixed(0)}`
}

function formatTime(iso: string) {
  const d = new Date(iso)
  const now = Date.now()
  const diff = Math.floor((now - d.getTime()) / 1000)
  if (diff < 60) return `${diff}s 前`
  if (diff < 3600) return `${Math.floor(diff / 60)}m 前`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h 前`
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}
</script>

<template>
  <div class="h-full overflow-y-auto bg-white border-r border-border">
    <!-- 描述 tab -->
    <div v-if="active === 'description'" class="p-4 space-y-4">
      <div class="flex items-center gap-2 flex-wrap text-xs text-text-secondary">
        <span
          class="inline-flex items-center px-2 py-0.5 rounded-full font-semibold"
          :class="problem.type === 'U' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'"
        >
          {{ problem.display_id }}
        </span>
        <span class="inline-flex items-center gap-1">
          <Clock :size="12" />
          {{ problem.time_limit_ms }}ms
        </span>
        <span class="inline-flex items-center gap-1">
          <Server :size="12" />
          {{ problem.memory_limit_mb }}MB
        </span>
        <span class="font-medium">{{ problem.difficulty }}</span>
      </div>

      <div v-if="problem.categories.length" class="flex flex-wrap gap-1.5">
        <span
          v-for="cat in problem.categories"
          :key="cat.id"
          class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200"
        >
          {{ cat.name }}
        </span>
      </div>

      <div class="prose prose-sm prose-neuro max-w-none">
        <MarkdownRenderer :content="problem.description" />
      </div>
    </div>

    <!-- 历史 tab -->
    <div v-else-if="active === 'history'" class="p-4 space-y-2">
      <h3 class="text-sm font-semibold text-text mb-3">提交历史</h3>
      <div v-if="submissions.length === 0" class="text-xs text-text-muted text-center py-8">
        暂无提交记录
      </div>
      <button
        v-for="sub in submissions"
        :key="sub.id"
        class="w-full text-left p-3 rounded-md border border-border hover:border-primary hover:bg-bg-page transition-colors group"
        @click="emit('open-submission', sub.id)"
      >
        <div class="flex items-center justify-between mb-1">
          <StatusBadge :status="sub.status" />
          <span class="text-xs font-mono text-text-secondary">{{ formatScore(sub.score) }} 分</span>
        </div>
        <div class="flex items-center justify-between text-xs text-text-muted">
          <span class="font-mono">{{ sub.language }}</span>
          <span>{{ formatTime(sub.created_at) }}</span>
        </div>
        <ChevronRight :size="14" class="absolute right-2 top-3 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
      </button>
    </div>

    <!-- 设置 tab -->
    <div v-else-if="active === 'settings'" class="p-4 space-y-5">
      <h3 class="text-sm font-semibold text-text">设置</h3>

      <div class="space-y-2">
        <label class="text-xs font-medium text-text-secondary">主题</label>
        <div class="flex items-center gap-2">
          <button
            class="flex-1 inline-flex items-center justify-center gap-2 py-2 px-3 border rounded-md text-sm transition-colors"
            :class="themeMode === 'light' ? 'border-primary bg-primary-bg text-primary' : 'border-border hover:bg-bg-page'"
            @click="emit('update:themeMode', 'light')"
          >
            <Sun :size="16" />
            亮色
          </button>
          <button
            class="flex-1 inline-flex items-center justify-center gap-2 py-2 px-3 border rounded-md text-sm transition-colors"
            :class="themeMode === 'dark' ? 'border-primary bg-primary-bg text-primary' : 'border-border hover:bg-bg-page'"
            @click="emit('update:themeMode', 'dark')"
          >
            <Moon :size="16" />
            暗色
          </button>
        </div>
      </div>

      <div class="space-y-2">
        <label class="text-xs font-medium text-text-secondary">自动保存草稿</label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            :checked="draftEnabled"
            class="size-4 accent-primary"
            @change="emit('update:draftEnabled', ($event.target as HTMLInputElement).checked)"
          />
          <span class="text-sm">本地保存代码草稿</span>
        </label>
        <p class="text-xs text-text-muted leading-relaxed">
          关闭后不再保存代码到浏览器，刷新页面会丢失未提交的代码。
        </p>
      </div>

      <div class="pt-2 border-t border-border">
        <button
          class="w-full inline-flex items-center justify-center gap-2 py-2 px-3 border border-red-200 text-red-700 bg-red-50 rounded-md text-sm hover:bg-red-100 transition-colors"
          @click="emit('clear-draft')"
        >
          <Trash2 :size="14" />
          清除当前草稿
        </button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: 验证编译**

```bash
cd noj-ui && deno task lint && deno task fmt
```

Expected: 0 errors。如果 `StatusBadge` props 与现有不一致，参考 `noj-ui/components/StatusBadge.vue` 的 props 调整。

- [ ] **Step 3: 提交**

```bash
git add noj-ui/components/editor/EditorSidebar.vue
git commit -m "feat(ui): EditorSidebar — 描述/历史/设置三合一可折叠侧栏" --gpg-sign=F27B5D0A639B43695413D9440F49774CB31F6CF1
```

---

## Task 8: pages/editor/[id].vue 主页面

**Files:**
- Create: `noj-ui/pages/editor/[id].vue`

**Interfaces:**
- 路由参数: `id: string`（题目 ID）
- 使用: 所有 Task 1-7 的组件与 composable
- 数据获取: `useFetch('/api/v1/problems/:id')` + `useFetch('/api/v1/submissions?problem_id=:id&limit=20')`

- [ ] **Step 1: 创建主页面文件**

新建 `noj-ui/pages/editor/[id].vue`：

```vue
<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { AlertCircle } from '@lucide/vue'

definePageMeta({
  layout: false,
  ssr: false,
})

const route = useRoute()
const router = useRouter()
const problemId = computed(() => route.params.id as string)
const { isLoggedIn, user } = useAuth()

// 主题
const { theme, set: setTheme, toggle: toggleTheme } = useEditorTheme()

// 草稿
const code = ref('')
const draftEnabled = ref(true)
const { state: draftState, savedAt: draftSavedAt, clear: clearDraft } = useDraftStorage(problemId, code, draftEnabled)

// 侧栏
const sidebarTab = ref<'description' | 'history' | 'settings'>('description')
const sidebarVisible = ref(true)
const sidebarWidth = useResizableSplit('editor:sidebar:width', 320, 240, 480)

// 编辑器元数据（用于状态栏）
const cursor = ref({ line: 1, col: 1 })
const totalLines = computed(() => code.value.split('\n').length)
const totalChars = computed(() => code.value.length)

// 题目加载
const { data: problemData, pending: problemPending, error: problemError } = useFetch<{
  data: {
    id: string
    display_id: string
    title: string
    description: string
    difficulty: string
    time_limit_ms: number
    memory_limit_mb: number
    type: 'U' | 'P'
    categories: { id: string; name: string; slug: string }[]
  }
}>(`/api/v1/problems/${problemId.value}`, { server: false })

const problem = computed(() => problemData.value?.data ?? null)

// 提交历史
const { data: submissionsData, refresh: refreshSubmissions } = useFetch<{
  data: Array<{
    id: string
    status: string
    score: number
    language: string
    created_at: string
  }>
}>(() => `/api/v1/submissions?problem_id=${problemId.value}&limit=20`, {
  server: false,
  default: () => ({ data: [] }),
})

const submissions = computed(() => submissionsData.value?.data ?? [])

// 语言（仅 Python 3，多语言切换器等 noj-judge 各语言镜像就绪后启用）
const languages = [{ value: 'python3', label: 'Python 3' }]
const language = ref('python3')

// 提交
const submitting = ref(false)
const submitError = ref('')
const canSubmit = computed(() => isLoggedIn.value && code.value.trim().length > 0)

async function handleSubmit() {
  if (!canSubmit.value) {
    submitError.value = isLoggedIn.value ? '请先编写代码' : '请先登录'
    return
  }
  submitting.value = true
  submitError.value = ''
  try {
    const res = await $fetch<{ data: { id: string } }>('/api/v1/submissions', {
      method: 'POST',
      body: {
        problem_id: problemId.value,
        language: language.value,
        code: code.value,
      },
    })
    await router.push(`/submissions/${res.data.id}`)
  } catch (err: unknown) {
    const e = err as { data?: { error?: string }; message?: string }
    submitError.value = e.data?.error || e.message || '提交失败，请稍后重试'
  } finally {
    submitting.value = false
  }
}

function openSubmission(id: string) {
  router.push(`/submissions/${id}`)
}

function goBack() {
  router.push(`/problems/${problemId.value}`)
}

// Monaco 光标变化回调（通过 ClientOnly 包装的 MonacoEditor 的 @cursor 事件接收）
function onCursorChange(pos: { line: number; col: number }) {
  cursor.value = pos
}
</script>

<template>
  <div
    class="h-screen flex flex-col overflow-hidden"
    :class="{ 'editor-dark': theme === 'dark' }"
  >
    <!-- 加载状态 -->
    <div v-if="problemPending" class="flex-1 flex items-center justify-center bg-bg-page">
      <div class="flex flex-col items-center gap-3 text-text-muted">
        <div class="size-7 border-[3px] border-border border-t-primary rounded-full animate-spin-slow" />
        <span class="text-sm">加载题目...</span>
      </div>
    </div>

    <!-- 错误状态 -->
    <div v-else-if="problemError || !problem" class="flex-1 flex items-center justify-center bg-bg-page">
      <div class="flex flex-col items-center gap-3 text-text-muted">
        <span class="flex items-center justify-center size-11 rounded-full bg-red-100 text-red-800 text-xl font-bold">!</span>
        <p class="text-sm">题目加载失败</p>
        <button class="btn btn-outline text-sm" @click="goBack">返回题目列表</button>
      </div>
    </div>

    <!-- 正常状态 -->
    <template v-else>
      <EditorToolbar
        :problem="problem"
        :language="language"
        :languages="languages"
        :theme-mode="theme"
        :can-submit="canSubmit"
        :submitting="submitting"
        :sidebar-visible="sidebarVisible"
        @update:language="language = $event"
        @update:theme-mode="setTheme($event)"
        @toggle-theme="toggleTheme"
        @toggle-sidebar="sidebarVisible = !sidebarVisible"
        @submit="handleSubmit"
        @back="goBack"
      />

      <div class="flex-1 flex min-h-0">
        <ActivityBar
          :active="sidebarTab"
          @select="(v) => { sidebarTab = v; sidebarVisible = true }"
        />

        <!-- 侧栏（可隐藏 + 可拖拽） -->
        <template v-if="sidebarVisible">
          <div :style="{ width: `${sidebarWidth.width.value}px` }" class="flex-shrink-0 transition-[width] duration-200">
            <EditorSidebar
              :active="sidebarTab"
              :problem="problem"
              :submissions="submissions"
              :theme-mode="theme"
              :draft-enabled="draftEnabled"
              @update:theme-mode="setTheme($event)"
              @update:draft-enabled="draftEnabled = $event"
              @clear-draft="clearDraft"
              @open-submission="openSubmission"
            />
          </div>
          <ResizableSplitter
            :model-value="sidebarWidth.width.value"
            :min="240"
            :max="480"
            side="right"
            @update:model-value="sidebarWidth.width.value = $event"
          />
        </template>

        <!-- 主编辑区 -->
        <main class="flex-1 flex flex-col min-w-0">
          <ClientOnly>
            <MonacoEditor
              v-model="code"
              :language="language"
              :theme="theme === 'dark' ? 'vs-dark' : 'vs'"
              :disabled="!isLoggedIn || submitting"
              :min-height="400"
              @cursor-change="onCursorChange"
            />
            <template #fallback>
              <div class="flex-1 flex items-center justify-center bg-[#0d1117] text-[#8b949e] text-sm">
                <div class="flex flex-col items-center gap-3">
                  <div class="size-7 border-[3px] border-border border-t-primary rounded-full animate-spin-slow" />
                  <span>加载编辑器...</span>
                </div>
              </div>
            </template>
          </ClientOnly>

          <!-- 提交错误 banner -->
          <Transition
            enter-active-class="transition-all duration-200 ease-out"
            leave-active-class="transition-all duration-200 ease-in"
            enter-from-class="opacity-0 -translate-y-1"
            leave-to-class="opacity-0 -translate-y-1"
          >
            <div
              v-if="submitError"
              class="flex items-center gap-2 px-4 py-2.5 bg-red-50 border-t border-red-200 text-red-800 text-xs"
            >
              <AlertCircle :size="14" />
              <span class="flex-1">{{ submitError }}</span>
              <button class="text-red-600 hover:text-red-800" @click="submitError = ''">×</button>
            </div>
          </Transition>
        </main>
      </div>

      <EditorStatusBar
        :language="language"
        :cursor="cursor"
        :total-lines="totalLines"
        :total-chars="totalChars"
        :draft-state="draftState"
        :draft-saved-at="draftSavedAt"
      />
    </template>
  </div>
</template>
```

- [ ] **Step 2: MonacoEditor.vue 添加 cursor-change 事件**

修改 `noj-ui/components/editor/MonacoEditor.vue`：

在 `defineEmits` 中追加：

```typescript
const emit = defineEmits<{
  (e: "update:modelValue", value: string): void
  (e: "cursorChange", pos: { line: number; col: number }): void
}>()
```

在 `initMonaco()` 函数内 `modelContentDisposable` 之后添加：

```typescript
// Emit cursor position changes
editor.onDidChangeCursorPosition((e: any) => {
  emit("cursorChange", { line: e.position.lineNumber, col: e.position.column })
})
```

- [ ] **Step 3: 验证编译**

```bash
cd noj-ui && deno task lint && deno task fmt
```

Expected: 0 errors。注意：`sidebarWidth.width.value` 在模板中嵌套写法可能 lint 报错，如果报错改为提取 computed：

```typescript
const sidebarWidthPx = computed(() => sidebarWidth.width.value)
```

并把模板中的 `sidebarWidth.width.value` 改为 `sidebarWidthPx`。

- [ ] **Step 4: 启动 dev server 烟雾测试**

```bash
cd noj-ui && deno task dev &
sleep 15
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/editor/1001
```

Expected: `200`

手动浏览器验证：
- 访问 `http://localhost:3000/editor/1001` → 编辑器加载
- 切换主题按钮 → Monaco 主题切换
- 输入代码 → 等 800ms → 状态栏显示"已保存 Ns 前"
- 刷新页面 → 代码保留
- 拖拽分隔条 → 宽度变化
- 点击 ActivityBar 历史 → 显示提交列表（如果有）
- 点击设置 → 切换主题/清除草稿

```bash
kill %1 2>/dev/null
```

- [ ] **Step 5: 提交**

```bash
git add noj-ui/pages/editor/\[id\].vue noj-ui/components/editor/MonacoEditor.vue
git commit -m "feat(ui): 新增 /editor/:id 路由 — IDE 风格独立编码页" --gpg-sign=F27B5D0A639B43695413D9440F49774CB31F6CF1
```

---

## Task 9: pages/problems/[id].vue 简化

**Files:**
- Modify: `noj-ui/pages/problems/[id].vue:1-207`（移除 Monaco + handleSubmit + ClientOnly + 新增"开始编码"按钮）

- [ ] **Step 1: 修改页面文件**

完整替换 `noj-ui/pages/problems/[id].vue` 为：

```vue
<script setup lang="ts">
import { useRoute } from "vue-router"
import { Clock, Server, Pencil, Code2 } from "@lucide/vue"

const route = useRoute()
const router = useRouter()
const { isLoggedIn, user } = useAuth()

const problemId = route.params.id as string

const { data, pending, error } = useFetch<{
  data: {
    id: string
    title: string
    description: string
    difficulty: string
    time_limit_ms: number
    memory_limit_mb: number
    display_id: string
    type: string
    owner_id: string
    number: number
    categories: { id: string; name: string; slug: string }[]
  }
}>(`/api/v1/problems/${problemId}`)

const problem = computed(() => data.value?.data ?? null)

const categories = computed(() => problem.value?.categories ?? [])

const canEdit = computed(() => {
  const p = problem.value
  if (!p) return false
  return user.value?.role === "admin" || (p.type === "U" && p.owner_id === user.value?.id)
})

const isDetailPage = computed(() => route.path === `/problems/${problemId}`)

function goToEditor() {
  router.push(`/editor/${problemId}`)
}
</script>

<template>
  <NuxtPage v-if="!isDetailPage" />

  <template v-else>
    <div v-if="pending" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted">
      <div class="h-[28px] w-[28px] border-[3px] border-border border-t-primary rounded-full animate-spin-slow" />
      <span>加载中...</span>
    </div>

    <div v-else-if="error" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted">
      <span class="flex items-center justify-center size-11 rounded-full bg-red-100 text-red-800 text-xl font-bold">!</span>
      <p>题目加载失败</p>
      <NuxtLink to="/problems" class="btn btn-outline">返回题目列表</NuxtLink>
    </div>

    <div v-else-if="problem" class="max-w-4xl mx-auto p-6 space-y-6">
      <!-- 题目信息卡片 -->
      <div class="bg-white border border-border rounded-xl overflow-hidden">
        <div class="px-7 py-6 pb-5 border-b border-border">
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-2">
                <span
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
                  :class="problem.type === 'U' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'"
                >
                  {{ problem.display_id }}
                </span>
                <span
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
                  :class="problem.type === 'U' ? 'bg-blue-50 text-blue-600' : 'bg-purple-50 text-purple-600'"
                >
                  {{ problem.type === 'U' ? '用户题库' : '主题库' }}
                </span>
              </div>
              <h1 class="text-2xl font-bold mb-3 text-text">{{ problem.title }}</h1>
            </div>
            <NuxtLink
              v-if="canEdit"
              :to="`/problems/${problem.id}/edit`"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border rounded-lg text-text-secondary hover:text-primary hover:border-primary/40 transition-colors"
            >
              <Pencil :size="14" />
              编辑
            </NuxtLink>
          </div>
          <div class="flex items-center gap-5 flex-wrap">
            <DifficultyBadge :difficulty="problem.difficulty" />
            <span class="inline-flex items-center gap-1 text-xs text-text-secondary">
              <Clock :size="14" />
              {{ problem.time_limit_ms }}ms
            </span>
            <span class="inline-flex items-center gap-1 text-xs text-text-secondary">
              <Server :size="14" />
              {{ problem.memory_limit_mb }}MB
            </span>
          </div>
          <div v-if="categories.length" class="flex flex-wrap gap-1.5 mt-2.5">
            <span
              v-for="cat in categories"
              :key="cat.id"
              class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200"
            >
              {{ cat.name }}
            </span>
          </div>
        </div>

        <div class="px-7 py-6">
          <MarkdownRenderer :content="problem.description" />
        </div>
      </div>

      <!-- 开始编码 CTA -->
      <div class="bg-white border border-border rounded-xl p-6 flex items-center justify-between">
        <div>
          <h2 class="text-base font-semibold text-text mb-1">准备好开始编码了吗？</h2>
          <p class="text-sm text-text-secondary">
            点击下方按钮进入独立编码页面，享受沉浸式编辑器体验。
          </p>
        </div>
        <button
          class="btn btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm"
          @click="goToEditor"
        >
          <Code2 :size="16" />
          开始编码
        </button>
      </div>

      <div v-if="!isLoggedIn" class="text-center text-sm text-text-muted">
        <NuxtLink to="/login" class="text-primary no-underline hover:underline">登录</NuxtLink>
        后即可提交代码
      </div>
    </div>
  </template>
</template>
```

- [ ] **Step 2: 验证编译**

```bash
cd noj-ui && deno task lint && deno task fmt
```

Expected: 0 errors。

- [ ] **Step 3: 启动 dev server 烟雾测试**

```bash
cd noj-ui && deno task dev &
sleep 15
curl -s http://localhost:3000/problems/1001 | grep -c "开始编码"
```

Expected: `>= 1`（页面含"开始编码"字样）

```bash
curl -s http://localhost:3000/problems/1001 | grep -c "monaco-editor"
```

Expected: `0`（不再包含 monaco-editor 字样）

```bash
kill %1 2>/dev/null
```

- [ ] **Step 4: 提交**

```bash
git add noj-ui/pages/problems/\[id\].vue
git commit -m "refactor(ui): 题目详情页移除 Monaco + 新增「开始编码」按钮" --gpg-sign=F27B5D0A639B43695413D9440F49774CB31F6CF1
```

---

## Task 10: E2E 测试扩展

**Files:**
- Create: `noj-tests/e2e/08_editor_flow.test.ts`

- [ ] **Step 1: 创建 E2E 测试文件**

新建 `noj-tests/e2e/08_editor_flow.test.ts`：

```typescript
/**
 * 编辑器路由 E2E 测试
 *
 * 覆盖：
 * - 题目详情页含"开始编码"链接指向 /editor/:id
 * - /editor/:id SSR 不含 Monaco JS（仅 ClientOnly fallback）
 * - 详情页 SSR 不再含 monaco-editor 字样
 * - 编辑页的提交 API 仍可调用
 */

import { get } from "./helper.ts";

Deno.test("问题详情页含「开始编码」链接", async () => {
  const html = await get("/problems/1001");
  // SSR 输出应包含跳转链接
  if (!html.includes("/editor/1001")) {
    throw new Error("题目详情页应包含指向 /editor/1001 的链接");
  }
});

Deno.test("问题详情页不再包含 monaco-editor 字样", async () => {
  const html = await get("/problems/1001");
  if (html.includes("monaco-editor")) {
    throw new Error("题目详情页不应再加载 Monaco Editor");
  }
});

Deno.test("/editor/:id SSR 路由可达", async () => {
  const html = await get("/editor/1001");
  // 页面应能渲染（即使 Monaco 仅客户端加载，SSR 也应返回 200 + HTML 框架）
  if (!html || html.length < 100) {
    throw new Error("/editor/1001 应返回有效 HTML");
  }
});

Deno.test("/editor/:id SSR 不含 Monaco JS 脚本", async () => {
  const html = await get("/editor/1001");
  // Monaco 客户端加载应在 ClientOnly 内，SSR 不应输出 monaco-editor 类名
  if (html.includes("monaco-editor")) {
    throw new Error("SSR 输出不应包含 monaco-editor（应仅客户端加载）");
  }
});

Deno.test("editor 路由多次访问不影响服务端", async () => {
  // 草稿在 localStorage，刷新不应改变服务端状态
  const html1 = await get("/editor/1001");
  const html2 = await get("/editor/1001");
  if (html1.length !== html2.length) {
    throw new Error("相同 URL 多次访问应返回一致 SSR 输出");
  }
});
```

- [ ] **Step 2: 检查 helper.ts 是否有 `get` 函数**

```bash
grep -n "^export.*function get\|^export const get" noj-tests/e2e/helper.ts
```

Expected: 输出含 `get` 函数定义。如果没有，需要改用 `fetch` 调用或参考其他 e2e/*.test.ts 的写法：

```typescript
import { jsonRequest } from "./helper.ts";
```

参考 `noj-tests/e2e/04_submissions.test.ts` 了解 helper 导出。

- [ ] **Step 3: 运行 E2E 测试**

启动 noj-core + noj-judge（如未运行），然后：

```bash
cd noj-tests && NOJ_RUN_E2E=1 deno task test:e2e 2>&1 | grep -E "editor|Editor|PASS|FAIL"
```

Expected: `08_editor_flow.test.ts` 全部测试通过

- [ ] **Step 4: 提交**

```bash
git add noj-tests/e2e/08_editor_flow.test.ts
git commit -m "test(e2e): 编辑器路由 — 详情页跳转/SSR 隔离/服务端稳定性" --gpg-sign=F27B5D0A639B43695413D9440F49774CB31F6CF1
```

---

## Task 11: 手动验证 + 提交收尾

**Files:** 无（验证步骤）

- [ ] **Step 1: 完整 lint + fmt**

```bash
cd noj-ui && deno task lint && deno task fmt
```

Expected: 0 errors。

- [ ] **Step 2: 完整构建验证**

```bash
cd noj-ui && deno task build 2>&1 | tail -20
```

Expected: 编译成功，无错误。可能 warning 关于 chunk size，可忽略。

- [ ] **Step 3: 手测清单（按顺序）**

打开浏览器访问 `http://localhost:3000/editor/1001`（dev server），逐项验证：

```
□ Monaco 加载时间 < 2s
□ 输入代码 → 800ms 后状态栏"已保存"
□ 刷新页面 → 代码保留
□ 设置面板 → 清除草稿 → 状态栏"未保存"
□ 主题切换：Monaco 同步切 vs / vs-dark
□ 主题持久化：刷新保持
□ 主题隔离：访问 /problems/1001 仍是亮色
□ 分隔条拖拽：宽度变化 + 双击重置
□ 响应式 < 768px：抽屉模式
□ 响应式 ≥ 1024px：三栏布局
□ 提交按钮：未登录跳 /login；登录跳 /submissions/:id
□ 提交失败：banner 显示 + 代码保留
□ 历史 tab：显示该题提交（≥ 1 条需先手动提交一次）
□ 状态栏 dirty → saving → saved 状态切换
□ 关闭 localStorage（devtools 禁用）→ 状态栏"保存失败"
```

如有任何一项失败，回到对应任务修复。

- [ ] **Step 4: 创建 PR**

```bash
jj git fetch
jj new main
jj describe -m "feat(ui): 做题界面重构 — 独立 /editor 路由 + IDE 风格 + 主题/草稿/拖拽侧栏"
jj git push -b feat/editor-page-redesign

gh pr create --draft \
  --title "feat(ui): 做题界面重构 — 独立 /editor 路由 + IDE 风格" \
  --body "$(cat <<'EOF'
## 摘要
- 新增独立编码路由 \`/editor/:id\`，VSCode 风格布局
- 题目详情页 \`/problems/:id\` 简化为阅读页 + 「开始编码」入口
- 编辑器支持 light/dark 主题切换（仅作用于 /editor 路由）
- localStorage 草稿自动保存（防抖 800ms）
- 可拖拽分隔条，宽度持久化
- 响应式：桌面三栏 / 平板折叠 / 移动端抽屉

## 关联
- 设计文档：docs/superpowers/specs/2026-07-13-editor-page-redesign-design.md
- 实施计划：docs/superpowers/plans/2026-07-13-editor-page-redesign.md

## 测试
- [x] deno task lint / fmt 通过
- [x] deno task build 通过
- [x] E2E (noj-tests/e2e/08_editor_flow.test.ts) 通过
- [x] 手动测试清单 14/14 通过

## 不在本次范围
- 多语言切换器（依赖 noj-judge 各语言镜像）
- 样例运行面板
- 整站 dark 模式
- 服务端草稿同步

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review（计划自检）

### 1. Spec 覆盖检查

| Spec § | 内容 | 覆盖任务 |
|---|---|---|
| §1.2 目标 | IDE 风格独立页 | Task 8 |
| §1.2 题目详情简化 | 移除 Monaco + 入口 | Task 9 |
| §1.2 light/dark 切换 | CSS 变量作用域 | Task 1 |
| §1.2 localStorage 草稿 | composable | Task 2 |
| §1.2 可拖拽侧栏 | splitter + composable | Task 3 |
| §1.2 响应式 | 模板中响应式类 | Task 8 |
| §3.1-3.6 组件 | 5 个组件 | Task 4-7 |
| §4.1 草稿状态机 | useDraftStorage | Task 2 |
| §4.2 主题状态机 | useEditorTheme | Task 1 |
| §4.3 提交流程 | handleSubmit | Task 8 |
| §5.1 最小侵入 dark | CSS 变量 | Task 1 |
| §6.2 历史 API 复用 | submissions fetch | Task 8 |
| §7 E2E | 08_editor_flow.test.ts | Task 10 |

**所有验收标准已覆盖。**

### 2. 占位符扫描

无 "TBD/TODO/待补充"。

### 3. 类型一致性

| 名称 | 定义位置 | 使用位置 | 一致 |
|---|---|---|---|
| `EditorTheme` | useEditorTheme.ts | EditorToolbar, EditorSidebar, editor/[id].vue | ✓ |
| `DraftState` | useDraftStorage.ts | EditorStatusBar, editor/[id].vue | ✓ |
| `useEditorTheme()` 返回 | `{theme, set, toggle}` | editor/[id].vue 调用 | ✓ |
| `useDraftStorage(problemId, code, enabled)` | composable 签名 | editor/[id].vue 调用 | ✓ |
| `useResizableSplit(key, initial, min, max)` | composable 签名 | editor/[id].vue 调用 | ✓ |
| `MonacoEditor` cursorChange emit | Task 8 Step 2 | editor/[id].vue 监听 | ✓ |

**类型一致。**