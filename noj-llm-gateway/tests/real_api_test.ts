// 真实 DeepSeek API 冒烟测试。
// 无 DEEPSEEK_API_KEY 时自动跳过；有 key 时验证一次最小 chat completion。
const API_KEY = Deno.env.get("DEEPSEEK_API_KEY");
const BASE_URL = Deno.env.get("DEEPSEEK_BASE_URL") ||
  "https://api.deepseek.com";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test({
  name: "real api: deepseek chat completion",
  ignore: !API_KEY,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
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
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json();
    assert(
      Array.isArray(data.choices) && data.choices.length > 0,
      "choices 应非空",
    );
  },
});
