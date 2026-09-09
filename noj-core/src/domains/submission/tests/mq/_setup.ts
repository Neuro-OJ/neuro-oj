/**
 * fake Redis 测试基础设施。
 *
 * 启动一个极简的 RESP 协议 mock TCP 服务器，支持 MQ 层测试所需的命令。
 * 从 tests/services/submissions.test.ts 提取并增强 BRPOP/PUBLISH/LPUSH 内存存储。
 *
 * 用法：
 * ```typescript
 * const fake = startFakeRedis();
 * try {
 *   Deno.env.set("REDIS_URL", fake.url);
 *   // ... 测试代码
 * } finally {
 *   await fake.stop();
 * }
 * ```
 */

// ── 公共类型 ─────────────────────────────────────

export interface FakeRedis {
  /** 客户端连接 URL */
  url: string;
  /** 停止 fake Redis 服务器 */
  stop: () => Promise<void>;
  /** 获取推送到指定队列的消息（LPUSH 存储的记录） */
  getMessages: (queue: string) => string[];
  /** 预置指定长度的队列，便于测试容量上限 */
  seedQueue: (queue: string, length: number) => void;
  /** 清除所有存储的队列数据 */
  clear: () => void;
}

// ── 主函数 ───────────────────────────────────────

export function startFakeRedis(): FakeRedis {
  const queues = new Map<string, string[]>();

  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const addr = listener.addr as Deno.NetAddr;
  const url = `redis://${addr.hostname}:${addr.port}/`;

  const connections = new Set<Deno.Conn>();

  const acceptTask = (async () => {
    for await (const conn of listener) {
      connections.add(conn);
      handleConnection(conn, queues).catch(() => {});
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
    await acceptTask.catch(() => {});
  };

  return {
    url,
    stop,
    getMessages: (queue: string) => queues.get(queue) ?? [],
    seedQueue: (queue: string, length: number) => {
      if (!Number.isInteger(length) || length < 0) {
        throw new Error(`队列长度必须是非负整数: ${length}`);
      }
      queues.set(
        queue,
        Array.from({ length }, (_, index) => `seed-message-${index}`),
      );
    },
    clear: () => queues.clear(),
  };
}

// ── RESP 处理 ─────────────────────────────────────

async function handleConnection(
  conn: Deno.Conn,
  queues: Map<string, string[]>,
): Promise<void> {
  const buf = new Uint8Array(4096);
  // deno-lint-ignore no-explicit-any
  let pending: any = new Uint8Array(0);

  while (true) {
    let n: number | null;
    try {
      n = await conn.read(buf);
    } catch {
      return;
    }
    if (n === null) return;

    pending = concat(pending, new Uint8Array(buf.subarray(0, n)));

    // 解析并响应所有完整 RESP 命令
    while (true) {
      const parsed = tryParseRespCommand(pending);
      if (!parsed) break;
      pending = parsed.rest;

      const reply = handleCommand(parsed.cmd, parsed.args, queues);
      if (reply) {
        try {
          await conn.write(reply);
        } catch {
          return;
        }
      }
    }
  }
}

interface ParsedCommand {
  cmd: string;
  args: string[];
  rest: Uint8Array;
}

function tryParseRespCommand(buf: Uint8Array): ParsedCommand | null {
  if (buf.length === 0 || buf[0] !== 0x2a) return null;
  const headerEnd = findCrlf(buf, 0);
  if (headerEnd < 0) return null;
  const n = parseInt(new TextDecoder().decode(buf.subarray(1, headerEnd)), 10);
  if (!Number.isFinite(n)) return null;

  let pos = headerEnd + 2;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    if (pos >= buf.length || buf[pos] !== 0x24) return null;
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

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ── 命令路由 ─────────────────────────────────────

function handleCommand(
  cmd: string,
  args: string[],
  queues: Map<string, string[]>,
): Uint8Array | null {
  switch (cmd) {
    case "PING":
      return renderRespString("PONG");
    case "QUIT":
      return renderRespString("OK");
    case "LPUSH":
      return handleLpush(args, queues);
    case "RPUSH":
      return handleRpush(args, queues);
    case "LRANGE":
      return handleLrange(args, queues);
    case "LREM":
      return handleLrem(args, queues);
    case "LLEN":
      return handleLlen(args, queues);
    case "DEL":
      return handleDel(args, queues);
    case "EVAL":
      return handleEval(args, queues);
    case "BRPOP":
      return handleBrpop(args, queues);
    case "PUBLISH":
      return renderRespInteger(1);
    case "CLIENT":
    case "SELECT":
    case "AUTH":
    case "HELLO":
    case "SETINFO":
      return renderRespString("OK");
    default:
      return renderRespString("OK");
  }
}

function handleLpush(
  args: string[],
  queues: Map<string, string[]>,
): Uint8Array {
  if (args.length < 2) return renderRespError("ERR wrong number of arguments");
  const key = args[0];
  const value = args[1];
  if (!queues.has(key)) queues.set(key, []);
  queues.get(key)!.unshift(value);
  // 返回队列长度（整数响应）
  return renderRespInteger(queues.get(key)!.length);
}

function handleLlen(
  args: string[],
  queues: Map<string, string[]>,
): Uint8Array {
  if (args.length < 1) return renderRespError("ERR wrong number of arguments");
  return renderRespInteger(queues.get(args[0])?.length ?? 0);
}

function handleRpush(
  args: string[],
  queues: Map<string, string[]>,
): Uint8Array {
  if (args.length < 2) return renderRespError("ERR wrong number of arguments");
  const key = args[0];
  const value = args[1];
  if (!queues.has(key)) queues.set(key, []);
  queues.get(key)!.push(value);
  return renderRespInteger(queues.get(key)!.length);
}

function handleLrange(
  args: string[],
  queues: Map<string, string[]>,
): Uint8Array {
  if (args.length < 3) return renderRespError("ERR wrong number of arguments");
  const list = queues.get(args[0]) ?? [];
  const start = Number(args[1]);
  const stop = Number(args[2]);
  const from = start < 0 ? Math.max(list.length + start, 0) : start;
  const to = stop < 0 ? list.length + stop : Math.min(stop, list.length - 1);
  return renderRespArray(from > to ? [] : list.slice(from, to + 1));
}

/** 实现 LREM 语义（count 0=全部、正数=从头、负数=从尾）。 */
function removeMatching(
  list: string[],
  count: number,
  value: string,
): number {
  let removed = 0;
  if (count === 0) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === value) {
        list.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }
  if (count > 0) {
    for (let i = 0; i < list.length && removed < count;) {
      if (list[i] === value) {
        list.splice(i, 1);
        removed += 1;
      } else i += 1;
    }
    return removed;
  }
  for (let i = list.length - 1; i >= 0 && removed < -count; i--) {
    if (list[i] === value) {
      list.splice(i, 1);
      removed += 1;
    }
  }
  return removed;
}

function handleLrem(
  args: string[],
  queues: Map<string, string[]>,
): Uint8Array {
  if (args.length < 3) return renderRespError("ERR wrong number of arguments");
  const list = queues.get(args[0]) ?? [];
  return renderRespInteger(removeMatching(list, Number(args[1]), args[2]));
}

function handleDel(
  args: string[],
  queues: Map<string, string[]>,
): Uint8Array {
  let deleted = 0;
  for (const key of args) {
    if (queues.delete(key)) deleted += 1;
  }
  return renderRespInteger(deleted);
}

function handleEval(
  args: string[],
  queues: Map<string, string[]>,
): Uint8Array {
  if (args.length < 3) return renderRespError("ERR unsupported EVAL arguments");
  const script = args[0];
  const numKeys = Number(args[1]);
  if (!Number.isInteger(numKeys) || numKeys < 1) {
    return renderRespError("ERR invalid numkeys");
  }
  const keys = args.slice(2, 2 + numKeys);
  const argv = args.slice(2 + numKeys);

  // producer 的「容量检查 + LPUSH」脚本。
  if (script.includes("LLEN")) {
    const key = keys[0];
    const maxLength = Number(argv[0]);
    if (!Number.isInteger(maxLength) || maxLength < 0) {
      return renderRespError("ERR invalid queue capacity");
    }
    const queue = queues.get(key) ?? [];
    if (queue.length >= maxLength) return renderRespInteger(-1);
    queue.unshift(argv[1]);
    queues.set(key, queue);
    return renderRespInteger(queue.length);
  }

  // 「LREM + RPUSH/LPUSH」原子搬运脚本（sweeper 重投 / 旧队列迁移）。
  if (script.includes("LREM") && keys.length === 2) {
    const list = queues.get(keys[0]) ?? [];
    const removed = removeMatching(list, 1, argv[0]);
    if (removed > 0) {
      const target = keys[1];
      const value = argv.length > 1 ? argv[1] : argv[0];
      if (!queues.has(target)) queues.set(target, []);
      if (script.includes("RPUSH")) queues.get(target)!.push(value);
      else queues.get(target)!.unshift(value);
    }
    return renderRespInteger(removed);
  }

  return renderRespError("ERR unsupported EVAL script");
}

function handleBrpop(
  args: string[],
  queues: Map<string, string[]>,
): Uint8Array {
  if (args.length < 2) return renderRespError("ERR wrong number of arguments");
  // 最后一个参数是 timeout，前面的参数是 keys
  const _timeout = parseInt(args[args.length - 1], 10);
  const keys = args.slice(0, -1);

  // 检查所有 key 是否有数据
  for (const key of keys) {
    const q = queues.get(key);
    if (q && q.length > 0) {
      const value = q.shift()!;
      // RESP 数组：[key, value]
      return renderRespArray([key, value]);
    }
  }

  // 无数据时，等待一小段时间再检查，然后返回 nil
  // 实际测试中不需要真的阻塞 10 秒
  return renderRespNilArray();
}

// ── RESP 序列化 ──────────────────────────────────

function renderRespString(s: string): Uint8Array {
  return new TextEncoder().encode(`+${s}\r\n`);
}

function renderRespError(s: string): Uint8Array {
  return new TextEncoder().encode(`-${s}\r\n`);
}

function renderRespInteger(n: number): Uint8Array {
  return new TextEncoder().encode(`:${n}\r\n`);
}

function renderRespArray(items: string[]): Uint8Array {
  const encoder = new TextEncoder();
  let result = `*${items.length}\r\n`;
  for (const item of items) {
    result += `$${encoder.encode(item).length}\r\n${item}\r\n`;
  }
  return encoder.encode(result);
}

function renderRespNilArray(): Uint8Array {
  return new TextEncoder().encode("*-1\r\n");
}
