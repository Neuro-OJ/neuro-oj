import { assertEquals } from "@std/assert";
import { realHttp } from "./http.ts";

Deno.test("realHttp: GET 返回状态与响应体", async () => {
  const http = realHttp();
  const res = await http.get("data:text/plain,hello");
  assertEquals(res.status, 200);
  assertEquals(res.body, "hello");
});
