/**
 * 兼容入口：HTTP 组合实现位于 `modules/http`，测试与外部工具暂时继续从
 * `src/app.ts` 导入。旧入口不再承载路由装配，后续可随调用方迁移删除。
 */
export { createApp } from "./modules/http/create-app.ts";
export type { CreateAppOptions } from "./modules/http/create-app.ts";
