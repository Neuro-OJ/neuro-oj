/**
 * 测试专用 Redis RESP 服务（P1-C）。
 *
 * 动机：生产环境 JWT 撤销检查测试需要证明"默认 Redis 客户端真的发出了
 * EXISTS"，而不是靠连接一个不存在的端口等待 ioredis 重试（旧实现约 31 秒）。
 *
 * 本服务只实现 ioredis 初始化与实际断言所需的最小命令集：
 * PING / INFO / CLIENT / SELECT / QUIT，以及收到 EXISTS 时立即返回约定
 * 错误并记录 key。它不模拟完整 Redis，也不修改生产重试策略。
 *
 * 协议解析支持命令分段到达（TCP 不保证一次 read 一条完整命令）。
 */

/** RESP 解析结果：已完整的命令 + 尚未收齐的剩余缓冲区。 */
export interface ParsedRespCommands {
  commands: string[][];
  rest: string;
}

/**
 * 从缓冲区解析 RESP 命令。
 *
 * 支持 `*N\r\n$len\r\n...` 数组形式与内联命令（`PING\r\n`）；参数只支持
 * bulk string（测试命令均为文本）。不完整命令留在 `rest`，由下一次 read
 * 拼接后继续解析。
 */
export function parseRespCommands(buffer: string): ParsedRespCommands {
  const commands: string[][] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (buffer[offset] !== "*") {
      const end = buffer.indexOf("\r\n", offset);
      if (end === -1) break;
      const line = buffer.slice(offset, end).trim();
      offset = end + 2;
      if (line) commands.push(line.split(/\s+/));
      continue;
    }

    const headerEnd = buffer.indexOf("\r\n", offset);
    if (headerEnd === -1) break;
    const count = Number(buffer.slice(offset + 1, headerEnd));
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`非法 RESP 数组长度：${buffer.slice(offset, headerEnd)}`);
    }
    let cursor = headerEnd + 2;
    const args: string[] = [];
    let complete = true;
    for (let index = 0; index < count; index++) {
      if (cursor >= buffer.length) {
        complete = false;
        break;
      }
      if (buffer[cursor] !== "$") {
        throw new Error("RESP 参数只支持 bulk string");
      }
      const lengthEnd = buffer.indexOf("\r\n", cursor);
      if (lengthEnd === -1) {
        complete = false;
        break;
      }
      const length = Number(buffer.slice(cursor + 1, lengthEnd));
      if (!Number.isInteger(length) || length < 0) {
        throw new Error(`非法 bulk string 长度：${length}`);
      }
      const dataStart = lengthEnd + 2;
      const dataEnd = dataStart + length;
      if (buffer.length < dataEnd + 2) {
        complete = false;
        break;
      }
      args.push(buffer.slice(dataStart, dataEnd));
      cursor = dataEnd + 2;
    }
    if (!complete) break;
    commands.push(args);
    offset = cursor;
  }

  return { commands, rest: buffer.slice(offset) };
}

/** 测试服务选项。 */
export interface FakeRedisServerOptions {
  /** EXISTS 返回的错误文本（不含前导 `-`），默认模拟 Redis 故障。 */
  existsError?: string;
}

/** 已启动的测试服务句柄。 */
export interface FakeRedisServer {
  /** 可直接交给 REDIS_URL 的连接串（db=0）。 */
  url: string;
  hostname: string;
  port: number;
  /** 收到的 EXISTS key（按到达顺序）。 */
  existsKeys: string[];
  /** 收到的全部命令（便于断言握手/重试次数）。 */
  commands: string[][];
  /** 关闭 listener 与所有已接受连接；可重复调用。 */
  close(): Promise<void>;
}

const DEFAULT_EXISTS_ERROR =
  "ERR simulated redis failure for jti revocation test";

function bulk(text: string): string {
  return `$${text.length}\r\n${text}\r\n`;
}

/**
 * 启动 127.0.0.1 随机端口的 RESP 服务。
 *
 * 收到目标 EXISTS 立即返回错误并记录 key；PING/INFO/CLIENT/SELECT/QUIT
 * 返回 ioredis 初始化可接受的响应。
 */
export function startFakeRedisServer(
  options: FakeRedisServerOptions = {},
): Promise<FakeRedisServer> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const address = listener.addr as Deno.NetAddr;
  const encoder = new TextEncoder();
  const existsKeys: string[] = [];
  const commands: string[][] = [];
  const sockets = new Set<Deno.Conn>();
  let closed = false;

  const respond = (args: string[]): string => {
    const name = (args[0] ?? "").toUpperCase();
    switch (name) {
      case "PING":
        return args.length > 1 ? bulk(args[1]!) : "+PONG\r\n";
      case "INFO":
        return bulk(
          "# Server\r\nredis_version:7.2.0\r\nredis_mode:standalone\r\nrole:master\r\n",
        );
      case "CLIENT":
      case "SELECT":
      case "QUIT":
      case "AUTH":
        return "+OK\r\n";
      case "EXISTS": {
        const key = args[1] ?? "";
        existsKeys.push(key);
        return `-${options.existsError ?? DEFAULT_EXISTS_ERROR}\r\n`;
      }
      default:
        return `-ERR unknown command '${args[0] ?? ""}'\r\n`;
    }
  };

  const handleConnection = async (conn: Deno.Conn): Promise<void> => {
    const decoder = new TextDecoder();
    const buffer = new Uint8Array(4096);
    let pending = "";
    try {
      while (!closed) {
        const read = await conn.read(buffer);
        if (read === null) break;
        pending += decoder.decode(buffer.subarray(0, read), { stream: true });
        const parsed = parseRespCommands(pending);
        pending = parsed.rest;
        for (const args of parsed.commands) {
          commands.push(args);
          await conn.write(encoder.encode(respond(args)));
          if ((args[0] ?? "").toUpperCase() === "QUIT") {
            return;
          }
        }
      }
    } catch {
      // 客户端主动断开/服务关闭：属正常路径。
    } finally {
      try {
        conn.close();
      } catch {
        // 已关闭。
      }
      sockets.delete(conn);
    }
  };

  const acceptLoop = (async () => {
    try {
      for await (const conn of listener) {
        sockets.add(conn);
        void handleConnection(conn);
      }
    } catch {
      // listener.close() 触发，正常退出。
    }
  })();

  return Promise.resolve({
    url: `redis://127.0.0.1:${address.port}/0`,
    hostname: "127.0.0.1",
    port: address.port,
    existsKeys,
    commands,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        listener.close();
      } catch {
        // 已关闭。
      }
      for (const conn of sockets) {
        try {
          conn.close();
        } catch {
          // 已关闭。
        }
      }
      sockets.clear();
      await acceptLoop;
    },
  });
}
