/**
 * 启动一个极简的 Redis RESP 协议 mock 服务器，响应 EVAL/LPUSH/LLEN/PING，
 * 让 pushJudgeTask 的队列操作不会触发真实 Redis 依赖。
 *
 * PGlite 测试模式下没有 Redis，但 Deno ESM 模块导出是 non-configurable，
 * 无法直接 monkey-patch pushJudgeTask。因此这里选择启动一个本地 mock Redis，
 * 把 REDIS_URL 指向它，让 pushJudgeTask 走完整 LPUSH 路径而无需外部依赖。
 */
// deno-lint-ignore require-await
export async function startFakeRedis(): Promise<
  { url: string; stop: () => Promise<void> }
> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const addr = listener.addr as Deno.NetAddr;
  const url = `redis://${addr.hostname}:${addr.port}/`;

  const connections = new Set<Deno.Conn>();
  const queueLengths = new Map<string, number>();
  const acceptTask = (async () => {
    for await (const conn of listener) {
      connections.add(conn);
      handleConnection(conn, queueLengths).catch(() => {/* ignore */});
    }
  })();

  const stop = async () => {
    for (const c of connections) {
      try {
        c.close();
      } catch { /* ignore */ }
    }
    connections.clear();
    try {
      listener.close();
    } catch { /* ignore */ }
    await acceptTask.catch(() => {/* ignore */});
  };

  return { url, stop };
}

async function handleConnection(
  conn: Deno.Conn,
  queueLengths: Map<string, number>,
): Promise<void> {
  const buf = new Uint8Array(4096);
  let pending: Uint8Array = new Uint8Array(0);

  while (true) {
    let n: number | null;
    try {
      n = await conn.read(buf);
    } catch {
      return;
    }
    if (n === null) return;
    const slice = buf.subarray(0, n);
    pending = concat(pending, new Uint8Array(slice));

    // 解析并响应所有完整 RESP 命令
    while (true) {
      const parsed = tryParseRespCommand(pending);
      if (!parsed) break;
      pending = parsed.rest;

      let reply: Uint8Array;
      switch (parsed.cmd) {
        case "PING":
          reply = renderRespString("PONG");
          break;
        case "LPUSH": {
          const queue = parsed.args[0] ?? "";
          const length = (queueLengths.get(queue) ?? 0) + 1;
          queueLengths.set(queue, length);
          reply = renderRespInteger(length);
          break;
        }
        case "LLEN": {
          const queue = parsed.args[0] ?? "";
          reply = renderRespInteger(queueLengths.get(queue) ?? 0);
          break;
        }
        case "INCR": {
          const key = parsed.args[0] ?? "";
          const value = (queueLengths.get(key) ?? 0) + 1;
          queueLengths.set(key, value);
          reply = renderRespInteger(value);
          break;
        }
        case "EXPIRE":
          reply = renderRespInteger(1);
          break;
        case "DEL":
          reply = renderRespInteger(parsed.args.length);
          break;
        case "EVAL": {
          // ioredis 参数顺序：script、numkeys、key、max、message。
          const queue = parsed.args[2] ?? "";
          const maxLength = Number(parsed.args[3]);
          const current = queueLengths.get(queue) ?? 0;
          if (current >= maxLength) {
            reply = renderRespInteger(-1);
          } else {
            const length = current + 1;
            queueLengths.set(queue, length);
            reply = renderRespInteger(length);
          }
          break;
        }
        case "CLIENT":
        case "SELECT":
        case "AUTH":
        case "HELLO":
        case "SETINFO":
          reply = renderRespString("OK");
          break;
        default:
          reply = renderRespString("OK");
      }
      await conn.write(reply);
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

interface ParsedCommand {
  cmd: string;
  args: string[];
  rest: Uint8Array;
}

function tryParseRespCommand(buf: Uint8Array): ParsedCommand | null {
  // RESP 数组：*<n>\r\n$<len>\r\n<bytes>\r\n...
  if (buf.length === 0 || buf[0] !== 0x2a /* * */) return null;
  const headerEnd = findCrlf(buf, 0);
  if (headerEnd < 0) return null;
  const n = parseInt(new TextDecoder().decode(buf.subarray(1, headerEnd)), 10);
  if (!Number.isFinite(n)) return null;

  let pos = headerEnd + 2;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    if (pos >= buf.length || buf[pos] !== 0x24 /* $ */) return null;
    const lenEnd = findCrlf(buf, pos);
    if (lenEnd < 0) return null;
    const len = parseInt(
      new TextDecoder().decode(buf.subarray(pos + 1, lenEnd)),
      10,
    );
    if (!Number.isFinite(len)) return null;
    pos = lenEnd + 2;
    if (pos + len + 2 > buf.length) return null;
    parts.push(new TextDecoder().decode(buf.subarray(pos, pos + len)));
    pos += len + 2;
  }

  return {
    cmd: (parts[0] ?? "").toUpperCase(),
    args: parts.slice(1),
    rest: buf.slice(pos),
  };
}

function findCrlf(buf: Uint8Array, from: number): number {
  for (let i = from; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
}

function renderRespString(s: string): Uint8Array {
  return new TextEncoder().encode(`+${s}\r\n`);
}

function renderRespInteger(n: number): Uint8Array {
  return new TextEncoder().encode(`:${n}\r\n`);
}
