# 实施任务

- [x] 1. 更新全局搜索 delta spec，定义默认 `has_more` 与显式 `include_total` 契约。
- [x] 2. 重构 core 搜索服务：默认跳过精确计数，使用 `limit + 1` 返回 `has_more`，并保留显式总数路径。
- [x] 3. 更新搜索路由与 core 服务/路由测试，覆盖默认、翻页和 `include_total` 情景。
- [x] 4. 更新 Nuxt 搜索页，使用 `has_more` 分页。
- [x] 5. 重写性能基准，分离高选择性与全命中场景。
- [x] 6. 运行格式化、静态检查和相关测试。
