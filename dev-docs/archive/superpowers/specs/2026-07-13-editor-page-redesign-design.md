# 做题界面重构 — 设计文档

> 关联范围: `noj-ui/pages/problems/[id].vue` + 新增 `pages/editor/[id].vue`
> 路线图: Phase 1.5 Production Readiness（用户体验增强）
> 作者: chenmou2012
> 日期: 2026-07-13

## 1. 背景与目标

### 1.1 问题

当前做题界面（`problems/[id].vue`）将题目阅读与代码编写强行塞在一个 1fr / 420px 双栏布局中：

- 编辑器被压缩到右侧窄列，无法提供沉浸式编码体验
- Monaco 硬编码 `vs-dark`，与全站亮色风格不一致
- 没有代码草稿自动保存，误关页面即丢失
- 无法切换主题、调整字号或自定义编辑器偏好
- 提交后没有平滑过渡，跳转突兀
- 仅 Python 3，但语言切换入口缺失（仅占位 TODO）

### 1.2 目标

打造一个 VSCode 风格的独立编码页 `/editor/:id`：

- **沉浸式全屏编辑器**，题目描述/历史/设置三栏可折叠
- **题目详情页简化**为纯阅读页 + "开始编码"入口
- **localStorage 草稿自动保存**，防误操作丢失
- **light/dark 主题切换**，仅作用于编辑页（不污染全站）
- **可拖拽分隔条**，用户自定义布局
- **响应式**：桌面三栏 / 平板折叠 / 移动端抽屉

### 1.3 非目标（YAGNI）

- 不做：多语言切换器（依赖 `noj-judge` 各语言镜像就绪，现状仅 Python 3）
- 不做：样例测试运行面板（本地模拟执行复杂度高，超出本期）
- 不做：整站 dark 模式（仅 `/editor` 路由内生效，避免 ~30 个页面颜色类重写）
- 不做：服务端草稿同步（localStorage 足够，后续再考虑跨设备同步）
- 不做：自定义键盘快捷键（除 Monaco 默认外不拦截任何组合键，避免冲突）
- 不做：题目讨论 / 评论
- 不做：diff 模式（CLAUDE.md 中提及但当前无场景）

### 1.4 验收标准

- [ ] 新增 `/editor/:id` 路由，使用 IDE 风格布局（Toolbar + ActivityBar + Sidebar + Monaco + StatusBar）
- [ ] `/problems/:id` 移除 Monaco 编辑器，新增"开始编码"按钮（链接到 `/editor/:id`）
- [ ] 编辑页主题可切换（light/dark），Monaco 同步切换（vs / vs-dark），离开路由后变量自动还原
- [ ] 代码草稿自动保存到 localStorage，刷新后可恢复，设置面板提供"清除草稿"
- [ ] 状态栏显示行数/字符数/自动保存状态/提交状态
- [ ] 侧栏可隐藏，宽度可拖拽，宽度持久化到 localStorage
- [ ] 响应式：≥1024px 三栏 / 768-1023px 折叠 ActivityBar / <768px 抽屉模式
- [ ] 现有提交流程（`POST /api/v1/submissions`）不变，提交后跳转 `/submissions/:id`
- [ ] 现有 `/api/v1/problems/:id`、`/api/v1/submissions` 等 API 无后端改动

---

## 2. 架构总览

### 2.1 路由变化

```
/problems/:id          ── 移除 Monaco ──→ 纯阅读页 + "开始编码"按钮
/editor/:id (新增)     ── VSCode 风格独立编码页
/submissions/:id       ── 不变（提交后跳转目标）
/api/v1/*              ── 不变（无后端改动）
```

### 2.2 组件树

```
pages/editor/[id].vue
├── EditorToolbar.vue          # 顶部：返回/标题/语言/主题/设置/提交
├── ActivityBar.vue            # 左侧 48px 图标栏
├── ResizableSplitter.vue      # 可拖拽分隔条（仅桌面）
├── EditorSidebar.vue          # 右侧可折叠侧栏
│   ├── 描述 tab               # 复用 MarkdownRenderer
│   ├── 历史 tab               # 复用 SubmissionTable
│   └── 设置 tab               # 主题/草稿开关/清除
├── MonacoEditor.vue           # 改造：新增 theme prop + watch
└── EditorStatusBar.vue        # 底部：语言/光标/字符/保存状态
```

### 2.3 Composables

```
composables/
├── useEditorTheme.ts          # 新增：light/dark 切换 + DOM 同步
├── useDraftStorage.ts         # 新增：localStorage 草稿读写 + 防抖
├── useResizableSplit.ts       # 新增：分隔条拖拽状态机
└── use-submissions.ts         # 已有：复用 useSubmissionDetail
```

---

## 3. 组件详细设计

### 3.1 EditorToolbar.vue

```typescript
defineProps<{
  problem: { id: string; display_id: string; title: string; type: 'U' | 'P' }
  language: string
  languages: { value: string; label: string }[]
  themeMode: 'light' | 'dark'
  canSubmit: boolean
  submitting: boolean
  sidebarVisible: boolean
}>()
defineEmits<{
  'update:language': [v: string]
  'update:themeMode': [v: 'light' | 'dark']
  'toggle-sidebar': []
  'open-settings': []
  submit: []
  back: []
}>()
```

**布局**：`h-12 border-b` | 左 `[← 返回] 题号 · 标题` | 中 `语言 ▾ | 🌓 主题 | ⚙ 设置` | 右 `[提交评测]`

### 3.2 ActivityBar.vue

```typescript
defineProps<{ active: 'description' | 'history' | 'settings' }>()
defineEmits<{ select: [v: 'description' | 'history' | 'settings'] }>()
```

`w-12` 垂直三图标按钮，active 项左侧 2px 高亮条 `bg-primary`。图标：描述/历史/设置。

### 3.3 ResizableSplitter.vue

```typescript
defineProps<{
  modelValue: number          // 当前宽度 px
  min: number; max: number
  side: 'left' | 'right'
}>()
defineEmits<{ 'update:modelValue': [v: number] }>()
```

- 6px 透明条，hover 蓝色边
- mousedown/move/up 拖拽
- 双击重置为 `(min + max) / 2`
- `< md` 断点自动隐藏

### 3.4 EditorSidebar.vue

```typescript
defineProps<{
  active: 'description' | 'history' | 'settings'
  problem: ProblemDetail
  submissions: SubmissionRow[]
  themeMode: 'light' | 'dark'
  draftEnabled: boolean
}>()
defineEmits<{
  'update:themeMode': [v: 'light' | 'dark']
  'update:draftEnabled': [v: boolean]
  'clear-draft': []
  'open-submission': [id: string]
}>()
```

| Tab | 内容 |
|---|---|
| description | 题号标签 + 难度/时限/内存 + 分类 + MarkdownRenderer |
| history | 提交历史表格（最多 20 条） |
| settings | 主题切换 / 自动保存开关 / 清除草稿按钮 |

### 3.5 MonacoEditor.vue（改造）

**新增 prop**：
- `theme: 'vs' | 'vs-dark'` — 控制 Monaco 主题

**新增 watch**：
```typescript
watch(() => props.theme, (t) => {
  monacoModule?.editor.setTheme(t)
})
```

**初始化改动**：`editor.create()` 中 `theme: props.theme ?? 'vs-dark'`

**保持不变**：`modelValue` / `language` / `disabled` / `minHeight` 及所有 sync watch 逻辑。

### 3.6 EditorStatusBar.vue

```typescript
defineProps<{
  language: string
  cursor: { line: number; col: number }
  totalLines: number
  totalChars: number
  draftState: 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
  draftSavedAt: Date | null
}>()
```

`h-6 border-t`：`Python 3 · UTF-8 · Ln 12, Col 4 · 142行 · 2,341字符 · ●已保存 3s 前`

- `draftState='dirty'`：圆点橙色 + 文字"编辑中…"
- `draftState='saving'`：圆点蓝色 pulse + "保存中…"
- `draftState='error'`：圆点红色 + "保存失败"
- 时间显示：`≤2s` → "刚刚"，`2-60s` → "Ns 前"，`>60s` → 具体时间

---

## 4. 状态机

### 4.1 草稿状态机（useDraftStorage）

```
states: idle | dirty | saving | saved | error
events: load | edit | debounce-fire | write-ok | write-fail | clear | unmount
```

**关键决策**：
- 防抖 800ms 写入 localStorage（避免每次按键都写）
- **不在**提交成功后清除草稿（避免评测失败后想改时草稿已没）
- 用户主动"清除草稿"才删
- QuotaExceeded 转为 `error` 状态，状态栏红色提示

```typescript
// composables/useDraftStorage.ts (示意)
const key = computed(() => `noj:draft:${problemId.value}`)

onMounted(() => {
  const raw = localStorage.getItem(key.value)
  if (raw) {
    const { content, updatedAt } = JSON.parse(raw)
    code.value = content
    savedAt.value = new Date(updatedAt)
    state.value = 'saved'
  }
})

watch(code, (val) => {
  if (!enabled.value) return
  if (timer) clearTimeout(timer)
  state.value = 'dirty'
  timer = setTimeout(() => {
    state.value = 'saving'
    try {
      localStorage.setItem(key.value, JSON.stringify({
        content: val, updatedAt: Date.now()
      }))
      savedAt.value = new Date()
      state.value = 'saved'
    } catch { state.value = 'error' }
  }, 800)
})
```

### 4.2 主题状态机（useEditorTheme）

```
state: 'light' | 'dark'
persist: localStorage `noj:editor:theme`
sync: Monaco setTheme + html.dark class（仅 /editor 路由）
```

**关键决策**：
- 默认 **dark**（编辑器沉浸式场景）
- 仅在 `/editor/:id` 页面根节点加 `class="editor-dark"`，**离开路由自动卸载**
- Monaco 主题映射：`dark → 'vs-dark'` / `light → 'vs'`

### 4.3 提交流程

```
用户点击 [提交评测]
  ↓
  submitting = true → 按钮 spinner + 禁用
  ↓
  $fetch('/api/v1/submissions', { method: 'POST', body })
  ↓
  成功 → router.push(`/submissions/${res.data.id}`)
  ↓
  失败 → submitError → 编辑器下方红色 banner（保留代码）
  ↓
  submitting = false
```

### 4.4 错误处理矩阵

| 场景 | UI 反馈 |
|---|---|
| 题目加载失败 | 全屏错误页 + "返回题目列表"（沿用 AsyncContent） |
| 提交 API 4xx/5xx | 编辑器下方红色 banner + 代码不丢失 |
| localStorage 写入失败 | 状态栏"●保存失败"橙色 |
| Monaco 加载失败 | ClientOnly fallback 降级为 `<textarea>` |
| 未登录访问 /editor | 跳 `/login?redirect=/editor/:id` |

---

## 5. 主题与样式系统

### 5.1 CSS 变量重定义（最小侵入）

现有所有颜色都通过 CSS 变量引用（`tailwind.config.ts:17-35` + `app.vue:22-29`）。**仅在 `.editor-dark` 作用域下重定义变量即可，无需新增任何 Tailwind `dark:` 类**。

```css
/* app.vue 中追加 */
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

**触发方式**（`pages/editor/[id].vue` 根节点）：
```vue
<div :class="{ 'editor-dark': theme === 'dark' }" class="h-screen flex flex-col">
```

**收益**：现有 Tailwind utility 类（如 `bg-white`、`text-text`、`border-border`）在 `.editor-dark` 内自动使用深色值。**零改动 utility 类**。

### 5.2 尺寸规范

| 元素 | 尺寸 | Tailwind 类 |
|---|---|---|
| Toolbar 高度 | 48px | `h-12` |
| ActivityBar 宽度 | 48px | `w-12` |
| StatusBar 高度 | 24px | `h-6` |
| Sidebar 默认宽度 | 320px | `w-[320px]` 动态绑定 |
| Sidebar 宽度边界 | 240-480px | props `min/max` |
| Splitter 宽度 | 6px | `w-1.5` |

### 5.3 动效

| 场景 | 时长 | 类型 |
|---|---|---|
| Sidebar 折叠 | 200ms | `transition-all` 宽度 |
| Splitter hover | 150ms | `transition-colors` |
| ActivityBar 切换 | 100ms | 背景色 fade |
| StatusBar 圆点 | 持续 | `animate-pulse`（仅 dirty/saving） |
| Tab 内容切换 | 150ms | 透明度 fade |
| 提交按钮 spinner | 持续 | Lucide `Loader2` `animate-spin` |

### 5.4 响应式断点

| 断点 | 行为 |
|---|---|
| `≥ 1024px` (lg) | 三列：ActivityBar + Sidebar + Editor，Splitter 可拖 |
| `768-1023px` (md) | ActivityBar 折叠为顶部 tab 切换条，Sidebar 默认隐藏 |
| `< 768px` (sm) | ActivityBar 隐藏，Sidebar 改为顶部下拉抽屉，Editor 全宽 |

---

## 6. 提交流程与 API 兼容性

### 6.1 提交 API（不变）

```typescript
$fetch('/api/v1/submissions', {
  method: 'POST',
  body: {
    problem_id: problemId,
    language,    // 仍为 'python3'
    code: code.value,
  }
})
```

### 6.2 历史数据获取

侧栏"历史" tab 调用现有 `GET /api/v1/submissions?problem_id=:id&limit=20`：

- 后端 `noj-core/src/routes/submissions.ts:56` 已支持 `problem_id` 查询参数
- 服务层 `noj-core/src/services/submissions.ts:176` 已实现 `eq(submissions.problem_id, problemId)` 过滤
- 前端复用 `use-submissions.ts` 的 `useSubmissions()`，传入 `{ problem_id, limit: 20 }` 参数

### 6.3 问题详情页改动

`problems/[id].vue` 改动：

- 删除 Monaco 相关代码（~25 行）
- 删除 `handleSubmit` 中的 `code` ref 与 `$fetch` 调用（~30 行）
- 新增 "开始编码"按钮：`<NuxtLink :to="`/editor/${problem.id}`" class="btn btn-primary">开始编码</NuxtLink>`
- 保留题目信息/描述渲染逻辑

---

## 7. 测试策略

### 7.1 E2E 测试扩展（`noj-tests/e2e/08_editor_flow.test.ts`）

| # | 场景 | 验证 |
|---|---|---|
| 1 | 题目详情跳编辑页 | `GET /problems/:id` HTML 含 `/editor/:id` 链接 |
| 2 | 编辑页 SSR 不含 Monaco JS | `GET /editor/:id` 响应中 Monaco 脚本不出现 |
| 3 | 提交 API 仍工作 | 编辑页表单 `POST /api/v1/submissions` → 201 |
| 4 | 详情页不再返回 Monaco | `GET /problems/:id` HTML 不含 `monaco-editor` 字样 |
| 5 | 草稿接口隔离 | 多次 `GET /editor/:id` 不影响服务端状态 |

**约束**：复用 `helper.ts` 的 `jsonRequest`，无浏览器自动化，不验证 Monaco 内部行为。

### 7.2 手测清单

```
□ Monaco 加载：/editor/:id < 2s 渲染
□ localStorage 草稿：输入 → 刷新 → 代码保留
□ 草稿清除：设置面板按钮生效
□ 主题切换：Monaco 与页面同步
□ 主题持久化：刷新保持
□ 主题隔离：访问 /problems/:id 仍为亮色
□ 分隔条拖拽：拖动 + 双击重置 + 持久化
□ 响应式：< 768px 抽屉 / 768-1023 折叠 / ≥1024 三栏
□ 提交流程：未登录跳 login / 登录后跳 /submissions/:id
□ 提交失败：banner + 代码保留
□ 历史加载：侧栏"历史"显示 ≥1 条
□ 状态栏：编辑后显示 dirty → saving → saved
□ 错误降级：localStorage 不可用时状态栏 error
```

### 7.3 视觉回归（可选，超出本期）

Playwright 截图对比作为后续增强项，**本次不做**。

---

## 8. 文件清单与工作量估算

| 模块 | 文件 | 类型 | 行数 |
|---|---|---|---|
| 页面 | `pages/editor/[id].vue` | 新增 | ~250 |
| 页面 | `pages/problems/[id].vue` | 改动 | -50 / +30 |
| 组件 | `components/editor/EditorToolbar.vue` | 新增 | ~120 |
| 组件 | `components/editor/ActivityBar.vue` | 新增 | ~60 |
| 组件 | `components/editor/EditorSidebar.vue` | 新增 | ~150 |
| 组件 | `components/editor/EditorStatusBar.vue` | 新增 | ~80 |
| 组件 | `components/editor/ResizableSplitter.vue` | 新增 | ~80 |
| 组件 | `components/editor/MonacoEditor.vue` | 改动 | +15 |
| 样式 | `app.vue` | 追加 | +20 |
| Composable | `composables/useEditorTheme.ts` | 新增 | ~30 |
| Composable | `composables/useDraftStorage.ts` | 新增 | ~50 |
| Composable | `composables/useResizableSplit.ts` | 新增 | ~60 |
| E2E | `noj-tests/e2e/08_editor_flow.test.ts` | 新增 | ~80 |
| **总计** | | | **~975 行** |

预估工期：**1.5-2 天**（含测试 + 验收）。

---

## 9. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 草稿数据在多标签页冲突 | 中 | 低 | 同源标签页监听 `storage` 事件同步（V2） |
| Monaco 与 SSR 冲突 | 低 | 中 | 已用 `<ClientOnly>` 包裹 |
| localStorage QuotaExceeded | 低 | 低 | 转 error 状态，UI 提示 |
| 拖拽分隔条移动端误触 | 中 | 低 | < md 隐藏 splitter |
| 编辑页主题影响全站 | 低 | 高 | CSS 变量作用域限定在 `.editor-dark` |
| Monaco worker 国内 CDN 慢 | 中 | 中 | 已 self-host（issue #82），现状不变 |

---

## 10. 后续可扩展（不在本期）

- 多语言切换器（依赖 noj-judge 各语言镜像）
- 样例运行面板（本地模拟执行）
- 整站 dark 模式
- 服务端草稿同步（跨设备）
- 题目讨论 / 评论
- diff 模式

---

## 附录 A：相关文件

- 现有题目详情：`noj-ui/pages/problems/[id].vue`
- 现有编辑器封装：`noj-ui/components/editor/MonacoEditor.vue`
- 提交 API 调用：`noj-core/src/routes/submissions.ts`
- 题目查询 API：`noj-core/src/routes/problems.ts`
- 提交历史 API：`noj-core/src/routes/submissions.ts` `GET /` 列表
- 主题 tokens：`noj-ui/app.vue:22-29` + `noj-ui/tailwind.config.ts:17-35`

## 附录 B：参考

- [Tailwind 暗色模式](https://tailwindcss.com/docs/dark-mode)
- [Monaco Editor 主题切换](https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor.IStandaloneCodeEditor.html#settheme)
- [VSCode 布局灵感](https://code.visualstudio.com/)