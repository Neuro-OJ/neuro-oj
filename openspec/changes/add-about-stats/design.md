# Design: 关于页重设计 + 公开统计端点

## Context

- 关于页入口：Navbar / Sidebar / FooterBar 三处均链接 `/about`，是访客（未登录用户）也能到达的页面。
- 设计 token：`app.vue :root` 的 `--c-*` 变量经 `main.css @theme` 映射为 Tailwind 类（`text-primary`、`bg-primary-bg`、`border-border`、`shadow-card` 等），本变更全部复用，不新增 token。
- 现有数据源：`/api/contributors`（Nitro 代理 → GitHub API，1h 缓存 + 静态回退）已存在；新增 `/api/v1/stats` 由 Nitro `[...slug].ts` 通配代理自动转发，UI 无需新增代理路由。

## Decisions

### D1. 统计口径

- `problems` = `problems` 表行数；`submissions` = `submissions` 表行数；`users` = `users` 表行数。
- `accepted` = `evaluation_results.status = 'Accepted'` 行数（与 `services/rankings.ts`、`services/dashboard.ts` 口径一致）。
- 全部 `Promise.all` 并发计数，单次往返各表 `count()`。

### D2. 端点公开性与错误处理

- 公开、无鉴权：与 `GET /api/v1/judge-images` 一致，注册在 `sse` 路由之前、不受 `authMiddleware` 影响。
- 响应形状：`{ data: { problems, submissions, users, accepted } }`（数字），沿用项目 `{ data }` 包装惯例。
- 维护模式（`maintenance_mode`）下 GET 放行，无需特殊处理。

### D3. UI 信息架构（自上而下 7 区）

1. **Hero**：深蓝渐变（`from-slate-900 via-blue-900 to-blue-700`，与首页轮播渐变呼应，白字对比度 17.85:1）；品牌徽标 + 一句话定位 + 两个 CTA（开始做题 → `/problems`；GitHub → 仓库）；免责声明改为 Hero 内 amber 提示条（提升合规信息权重）。
2. **锚点导航**：核心区别 / 技术架构 / 开源社区 三个锚点链接（低成本提升长页可用性）。
3. **统计面板**：4 个数字卡（题目 / 提交 / 用户 / 通过），`tabular-nums` + 主色数字；`server: false` 客户端拉取，骨架屏防 CLS（与贡献者加载策略一致）。
4. **核心区别**：保留 3 条原文内容，改为主色系（`bg-primary-bg text-primary`）图标 + 统一卡片，`lg:grid-cols-3`。
5. **技术架构**：`noj-ui → noj-core → noj-judge` 流程式（flex + 箭头图标），卡片统一中性底 + 主色图标，各附 GitHub 源码链接；下方一行数据流说明。
6. **开源社区**：GitHub 链接 + 贡献者头像墙（2/3/4 列网格，头像 + login + commits），保留头像失败回退首字母逻辑，加载态骨架。
7. **页脚**：AGPL-3.0 许可证链接 + 商业授权说明 + 免责声明重申（小字）。

### D4. 视觉收敛

- 删除原页面紫 / 绿 / 橙点缀，强调色统一为 `text-primary` / `bg-primary-bg`；架构模块色块改为统一中性 + 主色图标。
- 图标统一 `i-lucide-*`；圆角用 `rounded-lg/xl`；卡片统一 `bg-white border border-border rounded-xl shadow-card`。

## Risks

- 统计查询在数据量大时是 4 次 `count(*)` 全表扫描（`evaluation_results` 行数最大）。MVP 阶段可接受；后续可加缓存或物化视图（记录为遗留项）。
- 贡献者 API 依赖 GitHub 可达性，已有 1h 缓存 + 静态回退，风险已控。
