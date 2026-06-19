import { createApp } from "./app.ts";

const app = createApp();

const port = parseInt(Deno.env.get("PORT") || "8000");

Deno.serve({ port }, app.fetch);

console.log(`noj-core running on http://localhost:${port}`);
