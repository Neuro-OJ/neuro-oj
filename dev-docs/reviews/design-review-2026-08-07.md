# Neuro OJ 前端全站设计评审报告

- **日期**：2026-08-07
- **范围**：noj-ui 全部主要页面（40 个 URL 快照：auth 4 页、首页、题库 3 页、编辑器、提交 2 页、榜单、队列、竞赛、社区 4 页、私信、搜索、设置、用户、我的、admin 13 页）
- **取证方式**：dev server（`deno task dev`）SSR HTML 快照（`dev-docs/review-snapshots/`，gitignored）+ 源码静态审计 + `contrast.py` 对比度校验
- **目标用户**：全部角色（参赛选手 / 出题人 / 管理员）
- **工具**：design-review skill（6 维度加权评分 + Nielsen 10 启发式 + WCAG 2.2 清单 + anti-slop 清单）

> 无浏览器工具，视觉层（布局美感、留白节奏）从 HTML 结构与 CSS 类推断；报告区分「代码可证实」与「需浏览器目验」。

---

## 1. 评分总表

| # | 维度 | 权重 | 得分 | 要点 |
|---|------|------|------|------|
| 1 | Visual Hierarchy | 20% | **7** | 主页面 h1 齐全、标题层级清晰；admin 仪表盘 3 张同构卡无焦点；editor 无 h1 |
| 2 | Consistency | 20% | **6** | token 体系优秀但 off-token 硬编码 4 类、双表格体系、表头背景 3 种实现、潜在 primary 色双定义 |
| 3 | Accessibility | 20% | **5** | 基础扎实（label/autocomplete/skip link/alt/reduced-motion）但 2 项 P0（无 lang、footer 对比度）+ 4 项 Major |
| 4 | Usability | 20% | **7** | 四态 AsyncContent、删除确认、内联错误、Ctrl+K 优秀；队列无自动刷新、401 深链裸 JSON |
| 5 | Responsiveness | 10% | **6** | 移动优先 + 多数表格溢出正确；submissions 表格 320px 裁切、touch target 偏小 |
| 6 | Performance | 10% | **8** | Monaco 按需加载、图标本地打包、系统字体、骨架屏，无明显隐患 |

**加权总分 = 7×0.2 + 6×0.2 + 5×0.2 + 7×0.2 + 6×0.1 + 8×0.1 = 6.4 / 10**

> 评价：**Adequate（及格偏上）**——系统规范意识强（token、状态机、确认弹窗均是一流实践），但存在 2 项 P0 无障碍违例与若干跨页面一致性问题，建议修复后发布。

---

## 2. 优先分级 Findings 表

| # | 严重度 | 类别 | 位置 | 发现 | 建议 | 启发式/WCAG |
|---|--------|------|------|------|------|-------------|
| 1 | **Critical** | A11y | `nuxt.config.ts` head | `<html>` 无 `lang` 属性，全部页面（SSR 快照证实） | `app.head.htmlAttrs: { lang: 'zh-CN' }` | 3.1.1 (P0) |
| 2 | **Critical** | A11y | `layouts/default.vue` FooterBar / `--c-text-muted` + `--c-bg-dark` | footer 小字 `#64748b on #0f172a = 3.75:1`，低于 AA 4.5:1（`contrast.py` 实测） | footer 文本改用 `--c-text-secondary`（#94a3b8 = 6.96:1）或提亮 muted 暗色档 | 1.4.3 (P0) |
| 3 | **Critical** | Responsive | `pages/submissions/index.vue:195` | 9 列表格容器 `overflow-hidden` 无 `overflow-x-auto`，320px 视口内容被裁切 | 改 `overflow-x-auto`（对齐 ranking/queue 的表格模式） | 1.4.10 (P0) |
| 4 | Major | A11y | `components/ui/ToastBanner.vue` | 无 `role="status"` / `aria-live`，操作反馈屏幕阅读器不播报 | 加 `role="status" aria-live="polite"` | 4.1.3 |
| 5 | Major | Usability | `community/posts/[postId].vue`、`admin/community.vue` | 未登录深链 SSR 直接返回裸 JSON 401 错误体（无 layout/登录引导/返回路径） | 服务端捕获 401 渲染友好错误页或跳转 /login（`useApi` 或 layout 层处理） | H3 |
| 6 | Major | A11y | `.editor-dark`（`app.vue`） | 编辑器暗色下 muted 文本 `#64748b on #1e293b = 3.07:1`、primary `#3b82f6 on #1e293b = 3.98:1` 均不达 AA | 提亮 muted 至 `#94a3b8`、primary 至 `#60a5fa` | 1.4.3 |
| 7 | Major | Consistency | `layouts/admin.vue:61,76,118` + `Navbar.vue:2` | admin 布局/Navbar 硬编码 `bg-gray-50`/`bg-white`/`hover:bg-gray-100`，偏离 token（`--c-bg-page` #f8fafc、`--c-primary-hover-bg` #dbeafe） | 统一替换为 token 类；若未来加暗色模式需同步 | H4 |
| 8 | Major | Consistency | `admin/categories.vue:156,159`、`admin/judge-images.vue:192,195`、`admin/problems.vue:200-206`、`admin/users.vue:275`、`admin/index.vue:67-69` | 5 处 off-token 硬编码 hex（#f5f5f5/#dc2626/#d97706/#6b7280、statCard 图标色）；4 页复制粘贴同模式 | 提取 `--c-*` token 或语义类（`text-error-text` 等） | H4 |
| 9 | Major | Usability | `pages/queue.vue` | 评测队列页仅 onMounted 加载 + 手动刷新，无自动轮询（同页 1s 时钟但数据不刷新；admin 仪表盘已有轮询先例） | 复用 admin 的静默轮询模式（5-10s） | H1 |
| 10 | Major | Consistency | `submissions/index.vue:198-206` vs `admin/*.vue` | 双表格体系（手写 `<table>` 7 页 vs UTable 9 页），表头背景 3 种实现（#fafafa / bg-gray-50 / token #eff6ff） | 统一到 UTable 或至少统一表头 token | H4 |
| 11 | Minor | A11y | 全站 `<title>` | 所有页面统一 `Neuro OJ`，无页面级描述 | `useHead({ title: ... })` 按页设置 | 2.4.2 |
| 12 | Minor | A11y | `admin/*.vue` 图标按钮 | 仅 `title` 属性无 `aria-label`，accessible name 不完整（axe 会告警） | 加 `aria-label`（如「编辑」「删除」） | 4.1.2 |
| 13 | Minor | A11y | 自定义链接（Navbar 导航、页面卡片） | 无 `focus-visible` 样式类，仅浏览器默认 outline（UButton 系有 `focus-visible:outline-3`） | 全局统一 focus ring（与 UButton 对齐） | 2.4.7 |
| 14 | Minor | A11y | `pages/editor/[id].vue`、`pages/messages/index.vue` | editor 页无任何 h1-h6；messages 页首标题为 h2 无 h1 | 补页面级 h1 | 1.3.1 / 2.4.6 |
| 15 | Minor | A11y | `admin/*.vue` 表格操作按钮 `w-[30px] h-[30px]`（7 处） | 低于 44px 触控推荐尺寸（≥24px 达标） | 扩至 36-44px 或加大间距 | 2.5.8 |
| 16 | Minor | Taste | `admin/judge-images.vue:214-215`、`admin/users.vue:428,431` | UI 文案 em-dash（「精确版本 — 仅匹配…」「封禁于 X — Y」） | 改为逗号/顿号（anti-slop） | — |
| 17 | Enhancement | Consistency | main.css `@theme` | `--ui-color-primary-*` 仍引用 Nuxt UI 默认 green 色阶，与应用的 blue `--color-primary-*` 并存（当前无组件消费 `var(--ui-primary)`，可见均为蓝，属潜在隐患） | 显式覆盖 `--ui-color-primary-*` 为 blue 色阶 | H4 |
| 18 | Enhancement | Taste | `admin/index.vue` | 3 张同构统计卡（对称 + 图标硬编码色） | 差异化布局（bento/主次卡） | H8 |
| 19 | Enhancement | Usability | 全站 | 无 onboarding/帮助入口（H10） | 考虑 about 页扩展 FAQ 或空态引导 | H10 |
| 20 | Enhancement | Taste | `assets/css/main.css` `.prose-neuro` | `pre`/`blockquote` 3px 彩色左边条（内容排版样式，非 alert/callout，可接受） | 若追求极简可去掉；非阻塞 | — |

---

## 3. 各维度详解

### 3.1 Visual Hierarchy（7/10）
- ✅ 主页面均有 h1（题库/榜单/队列/提交/社区/竞赛/搜索），标题字号梯度 text-22px→2xl→3xl 一致
- ✅ auth 页卡片式聚焦（max-w-[380px] 居中，主行动按钮唯一）
- ⚠️ admin 仪表盘 3 张统计卡等权无焦点；editor 无 h1
- 需浏览器目验：留白节奏与行宽（正文容器 max-w-[800-960px]，未验证 60-75ch）

### 3.2 Consistency（6/10）
- ✅ token 体系一流：`app.vue :root` 定义 `--c-*` → `main.css @theme` 映射 Tailwind（颜色/radius 6px/阴影 3 档/字号 11-28px）→ `--ui-*` 桥接 Nuxt UI
- ✅ 组件复用良好：PaginationNav 11 处、AsyncContent/StatusBadge/TableSkeleton/DialogModal 多页复用
- ❌ off-token 硬编码 4 类（admin 操作按钮、submissions 表头、statCard 图标色、代码块暗色板——后者为有意设计）
- ❌ 双表格体系 + 表头背景 3 种实现
- ❌ admin/Navbar 用 gray 系（gray-50/100/white）而主内容 hover 用 blue 系 token，两套 hover 语义并存

### 3.3 Accessibility（5/10）
**达标项**（值得肯定）：
- skip link（default `#main` + admin `#admin-main`）✅
- 表单 autocomplete 全覆盖（login/register/forgot/change-password）✅
- img alt + 加载失败回退 ✅；UInput 均带 label ✅
- AsyncContent loading `role="status" aria-live="polite"` / error `role="alert"` + 重试 ✅
- 全局 `prefers-reduced-motion` 降级 ✅
- 亮色模式 token 对比度整体健康（正文 13.98:1、链接 5.17:1、状态色 5.95-7.09:1）✅

**违例**：见 Findings #1-6、#11-15（2 项 Critical P0 + 4 项 Major）。

### 3.4 Usability（7/10）
- ✅ AsyncContent 四态状态机（loading/error/empty/data）统一管理，search/problems/submissions/ranking 复用
- ✅ 删除等破坏性操作一律 UModal 确认（6 个 admin 页同模式）
- ✅ 表单内联错误（formError 文字提示）+ 错误恢复路径（「返回题目列表」）
- ✅ Ctrl+K 搜索快捷键 + 筛选栏可见（H6/H7）
- ❌ 队列页无自动刷新（H1）；401 深链裸 JSON（H3）；无帮助入口（H10）

### 3.5 Responsiveness（6/10）
- ✅ 移动优先（sm: 61 处）+ 桌面增强（lg: 24 处）；根容器 overflow-x-hidden
- ✅ ranking/queue/竞赛榜单表格均 overflow-x-auto；固定宽度容器均用 max-w 可收缩
- ❌ submissions 表格 overflow-hidden 裁切（Critical #3）；md 层覆盖薄（7 处）；30px 操作按钮

### 3.6 Performance（8/10）
- ✅ Monaco `await import("monaco-editor")` 按需加载，仅编辑器页触发
- ✅ @nuxt/icon `serverBundle: 'local'` 图标本地打包；字体系统栈（远程 provider 关闭，SSR 不挂起）
- ✅ 全站仅 4 张图且 2 张 `loading="lazy"`；TableSkeleton 骨架屏 3 页
- ✅ admin 仪表盘轮询静默失败不打断（lastSuccessfulRefresh）
- ⚠️ 需浏览器目验：首屏 JS 体积（Nuxt+UI 全家桶）与 LCP

---

## 4. 修复路线图

**Quick wins（<1h each）**：`html lang`（#1）、footer 对比度（#2）、submissions 表格 overflow（#3）、ToastBanner aria-live（#4）、页面 title（#11）、图标按钮 aria-label（#12）

**组件标准化**：off-token hex → token（#8）、表头背景统一（#10）、focus ring 全局统一（#13）

**流程修复**：401 深链友好错误页（#5）、队列自动轮询（#9）

**新模式**：editor/messages 补 h1（#14）、编辑器暗色对比度校准（#6）、全局暗色模式（若产品决策需要，另立变更）

---

## 5. 取证边界声明

- 无浏览器工具：视觉美感、动效观感、真实 320px 渲染、键盘实走查、屏幕阅读器实测 **未执行**，仅代码级推断
- admin 受保护页与动态路由（problems/1001 等）在 noj-core 未运行下取证，数据态为 loading/error/空态；populated 态从源码列定义/行渲染确认
- 快照留存于 `dev-docs/review-snapshots/`（gitignored），可随时人工复核
