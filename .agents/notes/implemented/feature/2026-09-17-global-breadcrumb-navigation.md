# Agent Note: 全局面包屑导航（集中注册表 + 布局接入）

Status: implemented

## Problem

站内此前没有任何面包屑：层级导航全靠各页面手写的「返回 X」链接。实测有 17 处
i-lucide-arrow-left 图标，文案各异（返回 / 返回题目详情 / 返回竞赛 / 返回通知 …），
同类页面的导航行为不一致，且返回链接常与标题挤在同一行把标题推低。

深层级页面只能回上一层：在 /contests/abc/problems/A 上用户看不到「竞赛 → 题目」的
完整路径，也无法直接跳到竞赛列表。新增页面更是默认没有层级导航——没有统一机制必然漂移。

## Decision

以「集中声明 + 纯函数解析 + 布局渲染」提供全站面包屑：

1. **注册表**（utils/breadcrumb.ts）。声明式 pattern/trail 路由 → 层级映射，
   导出 resolveBreadcrumb(path, locale) 与 matchBreadcrumbRoute(path)。
   未注册路径（/admin/*、认证页）返回空数组，调用方据此不渲染。
   放在 utils/ 可被 deno task test 直接断言，与本仓库既有约定一致。

2. **不引入全局中间件**（与 issue 初稿的差异）。issue 论证中间件是为了避免
   「页面 setup 写 state → SSR 首帧面包屑为空」。但层级本身是 route.path 与 locale
   的**纯函数**，布局组件在 SSR 首帧就能直接算出，无需任何 state 或中间件。
   少一个中间件即少一处 SSR/客户端双跑的分歧点。

3. **动态层文案分两步**：注册表先给出路由参数占位（如 1001），
   页面用 useBreadcrumbParams / useBreadcrumbLabel 回填人类可读文案
   （题名/竞赛名/用户名/帖子标题）。覆盖值挂在 useState 上并按「路径 + 参数名」
   分键，页面卸载时清理，避免路由之间串味；首帧先显示 ID，不闪空白。

4. **展示组件**（components/layout/BreadcrumbNav.vue）接入 layouts/default.vue。
   只渲染 ≥2 层的情况（单层无回跳价值）；末层不可点击并带 aria-current="page"，
   容器为 nav aria-label="面包屑"，分隔符 aria-hidden="true"。

5. **宽度跟随页面容器**。各内容页容器宽度不一致（860px / 960px / 4xl / 7xl）。
   页面用**可序列化**的 definePageMeta({ breadcrumbWidth }) 声明，未声明时取 960px；
   route.meta 在 SSR 首帧即可读，同样不需要额外状态。

6. **收敛「返回 X」**。由面包屑取代的返回链接逐页移除；但保留两类：
   - **编辑器全屏页**（layout: false，无面包屑）与竞赛页内的门控返回入口；
   - **指向「非父层级」的直达链接**：如提交详情页的「返回题目」实际指向该提交对应的
     题目（兄弟关系而非父子层级），改名「查看题目」并保留。这属于 issue 提到的
     「编辑器全屏页与竞赛页内的返回入口需单独判断」的同类边界。

7. **漂移门禁**（tests/breadcrumbRoutes_test.ts）。遍历 pages/ 把文件路径还原为路由
   模式，断言每个内容页都能解析出非空层级；白名单（admin/auth/首页/独立布局页）
   反向断言「确实不渲染」，防止误注册。新增内容页未注册即红灯。

## Alternatives considered

- **每页 definePageMeta({ breadcrumb: [...] })**：definePageMeta 是编译期宏、
  值需可序列化，无法放函数解析动态标题；且「每页手写」正是本 issue 要消除的漂移源。
- **全局中间件预置 useState**：如 Decision §2，层级是纯函数，中间件徒增
  SSR/客户端双跑面；issue 对中间件的论证针对的是「页面写 state」，而非本方案。
- **在注册表里静态写死动态标题**：题名/竞赛名只有请求后才知道，静态表不可能正确。
- **不处理面包屑与页面容器的宽度对齐**：面包屑会与标题错位；但为此引入新的全局状态
  代价更大，definePageMeta 零成本且可序列化。
- **本次接入 /admin/***：后台已有「分组 + 当前项」侧栏语义，再叠面包屑冗余；
  与 issue 的明确排除一致。
- **同时输出 BreadcrumbList JSON-LD**：属 SEO 增强，issue 明确不阻塞本 issue。

## Consequences

- 26 个内容页获得一致的多层导航；/contests/x/problems/A 三层均可点击回跳。
- 层级来源唯一：新增内容页若未在注册表登记，门禁测试立即失败，不会再「默认没有面包屑」。
- 动态层首帧显示路由参数、随后由页面数据精化；页面必须显式调用
  useBreadcrumbParams / useBreadcrumbLabel 才能显示人类可读文案。
- 未登录访客与登录用户看到相同面包屑（不依赖鉴权信息）。
- 纯前端改动：无后端、无数据库、无配置、无新依赖（复用 Nuxt UI 生态与既有 i18n 表）。
