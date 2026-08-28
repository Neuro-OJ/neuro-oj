// LLM 回放测试：无 key 可跑，验证录制 fixture 的结构与内容。

const FIXTURE_PATH = new URL(
  "./replay/fixtures/simple-chat.json",
  import.meta.url,
).pathname;

interface ReplayFixture {
  model: string;
  request: {
    messages: { role: string; content: string }[];
    max_tokens?: number;
  };
  response: { choices: { message: { role: string; content: string } }[] };
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("replay: simple chat fixture 可回放", async () => {
  const fixture: ReplayFixture = JSON.parse(
    await Deno.readTextFile(FIXTURE_PATH),
  );
  assert(fixture.model === "deepseek-chat", "model 应为 deepseek-chat");
  assert(fixture.request.messages[0]?.content === "ping", "请求内容应为 ping");
  assert(
    fixture.response.choices[0]?.message.content === "pong",
    "回放响应应为 pong",
  );
});
