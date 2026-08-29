// 录制 LLM 回放 fixture。
// 无 DEEPSEEK_API_KEY 时跳过；有 key 时调用 DeepSeek 并写入 simple-chat.json。
const API_KEY = Deno.env.get("DEEPSEEK_API_KEY");
const BASE_URL = Deno.env.get("DEEPSEEK_BASE_URL") ||
  "https://api.deepseek.com";

if (!API_KEY) {
  console.log("跳过录制：缺少 DEEPSEEK_API_KEY");
  Deno.exit(0);
}

const response = await fetch(`${BASE_URL}/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "deepseek-chat",
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 5,
  }),
});

if (!response.ok) {
  console.error(`录制失败：HTTP ${response.status}`);
  Deno.exit(1);
}

const data = await response.json();
const fixture = {
  model: "deepseek-chat",
  request: {
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 5,
  },
  response: data,
};

const fixturePath = new URL(
  "../tests/replay/fixtures/simple-chat.json",
  import.meta.url,
).pathname;
await Deno.mkdir(
  new URL("../tests/replay/fixtures", import.meta.url).pathname,
  {
    recursive: true,
  },
);
await Deno.writeTextFile(
  fixturePath,
  `${JSON.stringify(fixture, null, 2)}\n`,
);

console.log(`已录制到 ${fixturePath}`);
