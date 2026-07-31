# 关于页重设计 + 公开统计端点

## Why

`noj-ui/pages/about.vue` 是访客了解 Neuro OJ 的窗口（导航「关于」入口），但当前是静态信息陈列：

- 四个区块（区别 / 架构 / 社区 / 页脚）视觉权重均等，无焦点；Hero 无视觉锚点与转化出口（CTA）。
- 强调色失控：紫 / 蓝 / 绿 / 橙四种色混用，偏离品牌主色 `--c-primary`（#2563eb）。
- 免责声明（法律合规信息）以小号灰色字呈现，视觉权重过低。
- 缺少数据面板（题目数 / 提交数 / 用户数等），页面缺乏可信度与「活项目」感。

需要按项目设计 token 体系重新设计页面，并新增公开统计 API 支撑数据面板。

## What Changes

- `noj-core` 新增公开只读端点 `GET /api/v1/stats`：返回题目数、提交总数、注册用户数、评测通过数（Accepted）。
- `noj-ui` 重写 `pages/about.vue`：
  - 渐变 Hero（品牌定位 + 免责声明提示条 + 「开始做题 / GitHub」CTA）；
  - 统计面板（调用 `/api/v1/stats`，加载骨架态）；
  - 「与传统 OJ 的核心区别」收敛为统一主色系卡片网格；
  - 技术架构改为「noj-ui → noj-core → noj-judge」流程式展示，附源码链接；
  - 开源社区贡献者头像墙（沿用 `/api/contributors`），页脚补充 AGPL 许可证链接。

## Capabilities

### New Capabilities

- `public-stats`: 公开站点统计端点（只读、无鉴权，与 `judge-images` 一致）。
- `about-page`: 重新设计的关于页（叙事化信息架构 + 品牌视觉 + 数据面板）。

### Modified Capabilities

无。不涉及数据库 Schema、鉴权、评测链路。

## Impact

- `noj-core`：新增 `src/routes/stats.ts`（1 个只读聚合查询路由）与 `tests/routes/stats.test.ts`；在 `app.ts` 注册。
- `noj-ui`：仅重写 `pages/about.vue`（含模板 / 脚本 / 样式），复用现有设计 token 与 `/api/contributors` 代理；无新依赖。
- `noj-tests`：不涉及（stats 为公开只读端点，由 noj-core 路由测试覆盖）。
- 无 Drizzle 迁移、无环境变量、无 Redis 变更。
