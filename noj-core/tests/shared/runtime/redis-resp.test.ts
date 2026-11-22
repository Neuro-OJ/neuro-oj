/**
 * 测试专用 RESP 服务与解析器测试（P1-C，零外部依赖）。
 *
 * 只使用 loopback 随机端口；不连接真实 Redis，也不修改生产 Redis 配置。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  parseRespCommands,
  startFakeRedisServer,
} from "../../helpers/redis-resp.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

Deno.test("redis-resp: 分段到达的命令可拼接解析", () => {
  const first = parseRespCommands("*2\r\n$4\r\nPING\r\n");
  assertEquals(first.commands, []);
  assertEquals(first.rest, "*2\r\n$4\r\nPING\r\n");

  const second = parseRespCommands(`${first.rest}$4\r\nPING\r\nPING\r\n`);
  assertEquals(second.commands, [["PING", "PING"], ["PING"]]);
  assertEquals(second.rest, "");
});

Deno.test("redis-resp: EXISTS 返回约定错误并记录 key，QUIT 关闭连接", async () => {
  const server = await startFakeRedisServer({ existsError: "ERR simulated" });
  const conn = await Deno.connect({
    hostname: server.hostname,
    port: server.port,
  });
  try {
    await conn.write(
      encoder.encode(
        "PING\r\n*2\r\n$6\r\nEXISTS\r\n$3\r\nkey\r\n*1\r\n$4\r\nQUIT\r\n",
      ),
    );
    const chunks: string[] = [];
    const buffer = new Uint8Array(4096);
    while (true) {
      const read = await conn.read(buffer);
      if (read === null) break;
      chunks.push(decoder.decode(buffer.subarray(0, read), { stream: true }));
    }
    const output = chunks.join("");
    assert(output.includes("+PONG\r\n"));
    assert(output.includes("-ERR simulated\r\n"));
    assert(output.includes("+OK\r\n"));
    assertEquals(server.existsKeys, ["key"]);
    assert(
      server.commands.some((args) => args[0]?.toUpperCase() === "QUIT"),
    );
  } finally {
    try {
      conn.close();
    } catch {
      // 已由 QUIT 关闭。
    }
    await server.close();
  }
});

Deno.test("redis-resp: 并发连接关闭后拒绝新连接且可重复 close", async () => {
  const server = await startFakeRedisServer();
  const conns = await Promise.all(
    Array.from(
      { length: 3 },
      () => Deno.connect({ hostname: server.hostname, port: server.port }),
    ),
  );
  try {
    for (const conn of conns) await conn.write(encoder.encode("PING\r\n"));
    for (const conn of conns) {
      const buffer = new Uint8Array(64);
      const read = await conn.read(buffer);
      assertEquals(decoder.decode(buffer.subarray(0, read ?? 0)), "+PONG\r\n");
    }
  } finally {
    await server.close();
    for (const conn of conns) {
      try {
        conn.close();
      } catch {
        // 已关闭。
      }
    }
  }

  await assertRejects(
    () => Deno.connect({ hostname: server.hostname, port: server.port }),
    Error,
  );
  await server.close();
  assertEquals(server.commands.length, 3);
});
