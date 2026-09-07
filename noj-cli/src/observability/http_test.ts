import { assertEquals } from "@std/assert";
import { realHttp } from "./http.ts";

Deno.test("realHttp: GET 返回状态与响应体", async () => {
  const http = realHttp();
  const res = await http.get("data:text/plain,hello");
  assertEquals(res.status, 200);
  assertEquals(res.body, "hello");
});

Deno.test("realHttp: POST JSON 返回状态与响应体", async () => {
  const ac = new AbortController();
  let receivedBody = "";
  let receivedContentType = "";
  const server = Deno.serve(
    { port: 0, signal: ac.signal },
    async (req) => {
      receivedBody = await req.text();
      receivedContentType = req.headers.get("content-type") ?? "";
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  try {
    const port = server.addr.port;
    const body = JSON.stringify({ hello: "world" });
    const res = await realHttp().postJson(
      `http://127.0.0.1:${port}/echo`,
      body,
    );
    assertEquals(res.status, 201);
    assertEquals(JSON.parse(res.body).ok, true);
    assertEquals(receivedBody, body);
    assertEquals(receivedContentType, "application/json");
  } finally {
    ac.abort();
    await server.finished.catch(() => {});
  }
});
