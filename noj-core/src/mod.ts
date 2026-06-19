/**
 * noj-core — Neuro OJ 核心后端
 *
 * 基于 Deno + Hono，提供 RESTful API。
 * 通过 Redis MQ 向 noj-judge 分发评测任务。
 */

export { createApp } from "./app.ts";
