/**
 * community 服务层 re-export barrel。
 *
 * 实现已按 OpenSpec 子域拆分到以下文件，新代码请直接 import 子域文件：
 *   import { createPost } from "./community-content.ts";
 *   import { listBoards } from "./community-config.ts";
 *   import { listFeed } from "./community-social-feed.ts";
 *   import { createReport } from "./community-moderation.ts";
 *
 * 本 barrel 仅用于维持既有 import 路径兼容（routes/community.ts、
 * routes/{conversations,contests,search}.ts、tests/services/community*.test.ts
 * 均走此路径）。
 */
export * from "./community-config.ts";
export * from "./community-content.ts";
export * from "./community-social-feed.ts";
export * from "./community-moderation.ts";
