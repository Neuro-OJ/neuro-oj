/**
 * 搜索索引的共享类型（跨域契约）。
 *
 * 源域在业务写入后通过 `modules/application/search-tasks.ts` 登记
 * `search.index` 后台任务，由任务 worker 从最新数据库事实重建索引。
 * 原 Redis `noj:search:index` 列表与消费者已移除（#698 N1）：它在 Redis
 * 抖动时会静默丢失索引更新。
 */

/** 可被全局搜索索引的实体类型。 */
export type SearchEntityType =
  | "problem"
  | "user"
  | "community_post"
  | "community_comment"
  | "contest"
  | "submission"
  | "message"
  | "announcement";

/** 索引动作。 */
export type SearchIndexAction = "upsert" | "delete";
