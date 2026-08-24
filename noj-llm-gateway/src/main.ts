/**
 * noj-llm-gateway 入口。
 */
import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";

const config = loadConfig();
const app = createApp(config);

Deno.serve({ port: config.port }, app.fetch);
