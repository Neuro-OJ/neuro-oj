# Agent Note: 重构 noj-ui 设计系统（Precision Instrument）与核心主链路交互

Status: implemented

## Problem

多域迁移后，`noj-ui` 核心主链路存在明显的视觉与交互割裂：

1. **设计系统漂移**：`DESIGN.md` 仍锚定旧版 `cc05af79` 恢复目标，圆角混用 `rounded` / `rounded-lg` / `rounded-xl` / `rounded-full`，页面与卡片间出现 `breadcrumbWidth`（如 `960px` / `1008px`）与 `workspaceWidth`（`1008px`）错位，且多处散落硬编码色值（`bg-gray-50`、`text-blue-500`、`bg-indigo-50` 等）。
2. **核心链路交互断点**：顶栏 ⌘K 触发的是整页跳转而非域内命令面板（旧 `SearchPalette.vue` 使用旧全局搜索接口且未挂载）；域切换藏在用户菜单二级子菜单；题库筛选常驻 5 个下拉框挤占首屏且缺少 Chips；题目详情页 `ProblemHeader` 与 `ProblemMetaCard` 重复渲染 5 项元数据；做题工作区缺乏快捷键与样例「载入自测」闭环；提交列表仅支持回车过滤且缺乏进行中状态的自动轮询。

## Decision

1. **重写设计系统与三层语义 Token 底座**：
   - 将 `DESIGN.md` 与 `dev-docs/design/noj-design-tokens.md` 升级为 **Precision Instrument（精密评测工作台）** 体系，定义 Surface/Border、Brand/Interactive、Verdict/Difficulty 与 3 档圆角（`4px/6px/10px`），并同步至 `noj-ui`、`noj-docs`、`PRODUCT.md` 与 `AGENTS.md`。
   - 保持 `ui.colorMode: false` 与编辑器 `.editor-dark` 独立暗色边界不变，同时在 `:root` 与 `.editor-dark` 完整定义双套语义 Token，并统一浏览器原生表面（`::selection`、`caret-color`、滚动条、焦点环）。
   - 新建 `noj-ui/utils/workspace-layout.ts` 作为容器与面包屑宽度的单一事实来源。
2. **修复核心主链路交互**：
   - 新增 `useDomainCommandPalette` 与 `DomainCommandPalette.vue`，在 `default.vue` 接管 `Ctrl/Cmd+K` 与顶栏搜索点击，严格调用 `useDomainQuery().search(slug, ...)` 限定当前域；在 `Navbar.vue` 品牌右侧增加域切换胶囊并释放「提交」进入主导航候选池。
   - 重构域首页 `WorkspaceHero` 为紧凑域命令头，将签到反馈收敛到 450ms 内完成。
   - 重构 `ProblemFilterBar`（主行精简 + 可折叠高级筛选 + Active Filter Chips）与题库表格；去重 `ProblemHeader`（独立详情页传 `:show-stats="false"`，竞赛页保持默认）与 `ProblemMetaCard`。
   - 为 `DomainCodeWorkspace` 新增 `Ctrl/Cmd+Enter`（提交）、`Ctrl/Cmd+'`（自测）、`Ctrl/Cmd+B`（侧栏切换）、样例一键「载入自测」与结构化提交历史卡；在 `submissions/index.vue` 接入分段快切、350ms 防抖过滤与仅在存在 `pending/judging` 时启动的条件轮询。
3. **教学系统同步提效与视觉收敛**：
   - 将 `classrooms/index.vue` 顶部统计卡收敛为横向分组指标带，去掉任务卡片内部嵌套灰框并统一 `UAlert` 为 `variant="subtle"`；
   - 在 `classrooms/[classroomId]/index.vue` 移除与 `ClassroomNavigation` 重复的「班级成员」按钮；移除所有教学页硬编码 `breadcrumbWidth`，全部接入 `workspace-layout.ts`；
   - 升级 `AssignmentMatrix.vue`（表头列达标率进度条 + 单元格语义浅底）与 `assignments/[assignmentId]/index.vue`（批改抽屉「上一位 / 下一位学生」连续阅卷导航条 + Active Filter Chips），并同步更新教学子组件圆角（`rounded-md`）。
4. **富文本编辑器、知识图谱开关、教学互动与交互人体工程学多轮完善**：
   - 新增 `knowledgeEnabled` 运行时开关（`NUXT_PUBLIC_KNOWLEDGE_ENABLED`，默认关闭），在 `useKnowledge`、导航与对应页面统一隐藏未启用入口。
   - 升级 `MarkdownEditor.vue` 为标准/紧凑双模式（支持预览、工具栏与 `Ctrl/Cmd+Enter` 快捷提交），并统一替换社区发帖/评论、教学批注/求助回复、班级说明、个人签名与法务编辑页的原始输入框。
   - 重构作业与班级交互链路：移除「作业反馈」与作业/题单复制补题流程，在作业简介下方接入「作业全体通知（Markdown）」模块；将「学生求助」重构为 GitHub Issue 风格的 `AssignmentHelpList` + 独立详情页 `assignments/[assignmentId]/help/[helpId].vue`（支持已回复/待回复状态筛选与评论流，后端 `help.ts` 同步返回每条求助最新回答信息）；将「学生训练」并入「班级成员」列表与训练详情入口，精简教练端二级导航。
   - 扫描并修复全站细节动效与人体工程学断点：为 `MarkdownEditor` 补充 `Ctrl/Cmd+Enter` 快捷键与 `1800ms` 错误摇晃高亮，统一全局过渡动画、`prefers-reduced-motion` 兜底（含 `AnimatedCounter`）、`PaginationNav` 阈值平滑回顶、弹窗焦点恢复及组件测试 `UxMotionAndErgonomics.spec.ts`。

## Alternatives considered

- **直接修补旧样式而不改 `DESIGN.md` / Tokens**：只能掩盖局部对齐问题，无法解决圆角、表面层次、状态色和宽度分散的根因，且后续新页面仍会继续漂移。
- **全面引入全站暗色模式**：受限于既有大量亮色页面与 `nuxt.config.ts` 中 `ui.colorMode: false` 约束，本轮保持全站亮色 + 编辑器独立暗色，先建立双套 Token 结构以控制风险。

## Consequences

- `noj-ui/tests/browser/editorTheme.browser.test.ts` 随 `.editor-dark` 面板色（`#111827`）更新断言，保持所有 WCAG AA 对比度校验。
- `UserMenu.vue` 中的域切换子菜单暂时保留以维持现有单测与习惯兼容，与顶栏域切换器共用同一 `useAsyncData` 缓存键，不增加额外请求。
- 新增布局宽度工具与测试 `noj-ui/tests/workspace-layout_test.ts`，后续新增域内页面只需声明 `workspaceWidth` 即可自动对齐面包屑。
