# Tasks: 关于页重设计 + 公开统计端点

## Task 1: 后端公开统计端点

- [ ] 新增 `noj-core/src/routes/stats.ts`：`GET /stats` 返回 `{ data: { problems, submissions, users, accepted } }`，四个 `count()` 并发执行，口径与 rankings/dashboard 一致。
- [ ] 在 `noj-core/src/app.ts` 注册 `app.route("/api/v1", stats)`（公开路由，无鉴权）。
- [ ] 新增 `noj-core/tests/routes/stats.test.ts`：`resetDbForTest` 后请求，断言 200、`data` 字段为数字、种子数据可数。

## Task 2: 前端 about 页重写

- [ ] 重写 `noj-ui/pages/about.vue`：Hero（渐变 + CTA + 免责提示条）、锚点导航、统计面板（骨架 + `/api/v1/stats`）、特性网格、流程式架构、贡献者头像墙、页脚。
- [ ] 保留 `/api/contributors` 拉取与头像失败回退逻辑。

## Task 3: 质量检查

- [ ] `deno fmt` + `deno lint`（noj-core 与 noj-ui）。
- [ ] `deno test` 运行 stats 路由测试。
- [ ] `nuxt build` 或等价构建检查通过。
