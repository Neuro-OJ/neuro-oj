/**
 * 极简严格 Redis RESP2 客户端（纯 Deno TCP/TLS，零外部依赖）：
 * 在同一连接上按顺序严格执行 `AUTH`（如有凭据）→ `SELECT <db>` → `EVAL`，
 * 任一步未收到 `+OK` 立即中止，绝不重演旧版 `redis-cli -n <超界DB>` 报错后仍误在 DB 0 执行的风险。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §6.2 多副本约束）。
 */

import type { ParsedRedisConnection } from "./reset-config-helpers.ts";

/** 单行与块读取上限，避免异常或恶意响应造成内存放大。 */
const MAX_RESP_LINE_BYTES = 64 * 1024;
const MAX_RESP_BULK_BYTES = 4 * 1024 * 1024;
const MAX_RESP_ARRAY_LEN = 1024;
const MAX_RESP_DEPTH = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 严格 RESP `EVAL` 调用结果。 */
export type RedisEvalOutcome =
  | { ok: true; cleared: boolean }
  | { ok: false; timedOut: boolean; message: string };

type RespValue =
  | { type: "simple"; value: string }
  | { type: "error"; message: string }
  | { type: "integer"; value: number }
  | { type: "bulk"; value: string | null }
  | { type: "array"; value: RespValue[] | null };

/** 将 Redis 命令参数编码为 RESP2 Multi-Bulk 字节帧（UTF-8 精确字节长度）。 */
export function encodeRespCommand(args: readonly string[]): Uint8Array {
  const header = encoder.encode(`*${args.length}\r\n`);
  const crlf = encoder.encode("\r\n");
  const encodedArgs = args.map((arg) => {
    const bytes = encoder.encode(arg);
    const lenPrefix = encoder.encode(`$${bytes.byteLength}\r\n`);
    return { lenPrefix, bytes };
  });

  let total = header.byteLength;
  for (const part of encodedArgs) {
    total += part.lenPrefix.byteLength + part.bytes.byteLength +
      crlf.byteLength;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  out.set(header, offset);
  offset += header.byteLength;
  for (const part of encodedArgs) {
    out.set(part.lenPrefix, offset);
    offset += part.lenPrefix.byteLength;
    out.set(part.bytes, offset);
    offset += part.bytes.byteLength;
    out.set(crlf, offset);
    offset += crlf.byteLength;
  }
  return out;
}

async function writeAll(
  conn: Deno.Conn,
  data: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const written = await conn.write(data.subarray(offset));
    if (written <= 0) {
      throw new Error("Redis 连接在写入过程中提前关闭");
    }
    offset += written;
  }
}

/** 带增量缓冲与边界保护的 RESP2 解析器，兼容任意 TCP 分包与粘包。 */
class RespReader {
  #conn: Deno.Conn;
  #buf: Uint8Array = new Uint8Array(0);
  #pos = 0;

  constructor(conn: Deno.Conn) {
    this.#conn = conn;
  }

  async readValue(depth = 0): Promise<RespValue> {
    if (depth > MAX_RESP_DEPTH) {
      throw new Error("Redis RESP 嵌套层级超限");
    }
    const line = await this.#readLine();
    if (line.length === 0) {
      throw new Error("Redis 返回空响应行");
    }
    const prefix = line[0]!;
    const payload = line.slice(1);
    switch (prefix) {
      case "+":
        return { type: "simple", value: payload };
      case "-":
        return { type: "error", message: payload };
      case ":": {
        if (!/^-?\d+$/.test(payload)) {
          throw new Error(`Redis 整数响应格式无效：${payload}`);
        }
        const value = Number.parseInt(payload, 10);
        if (!Number.isSafeInteger(value)) {
          throw new Error("Redis 整数响应超出安全范围");
        }
        return { type: "integer", value };
      }
      case "$": {
        if (payload === "-1") {
          return { type: "bulk", value: null };
        }
        if (!/^\d+$/.test(payload)) {
          throw new Error(`Redis Bulk 长度无效：${payload}`);
        }
        const len = Number.parseInt(payload, 10);
        if (!Number.isSafeInteger(len) || len > MAX_RESP_BULK_BYTES) {
          throw new Error("Redis Bulk 长度超出安全上限");
        }
        const bytes = await this.#readExact(len);
        const tail = await this.#readExact(2);
        if (tail[0] !== 13 || tail[1] !== 10) {
          throw new Error("Redis Bulk 响应缺少 CRLF 结尾");
        }
        return { type: "bulk", value: decoder.decode(bytes) };
      }
      case "*": {
        if (payload === "-1") {
          return { type: "array", value: null };
        }
        if (!/^\d+$/.test(payload)) {
          throw new Error(`Redis Array 长度无效：${payload}`);
        }
        const count = Number.parseInt(payload, 10);
        if (!Number.isSafeInteger(count) || count > MAX_RESP_ARRAY_LEN) {
          throw new Error("Redis Array 长度超出安全上限");
        }
        const items: RespValue[] = [];
        for (let i = 0; i < count; i++) {
          items.push(await this.readValue(depth + 1));
        }
        return { type: "array", value: items };
      }
      default:
        throw new Error(`未知 Redis RESP 响应前缀：${prefix}`);
    }
  }

  async #readLine(): Promise<string> {
    while (true) {
      for (let i = this.#pos; i + 1 < this.#buf.byteLength; i++) {
        if (this.#buf[i] === 13 && this.#buf[i + 1] === 10) {
          const slice = this.#buf.subarray(this.#pos, i);
          this.#pos = i + 2;
          return decoder.decode(slice);
        }
      }
      const buffered = this.#buf.byteLength - this.#pos;
      if (buffered > MAX_RESP_LINE_BYTES) {
        throw new Error("Redis 响应行超过最大长度限制");
      }
      await this.#fill();
    }
  }

  async #readExact(length: number): Promise<Uint8Array> {
    while (this.#buf.byteLength - this.#pos < length) {
      await this.#fill();
    }
    const out = this.#buf.slice(this.#pos, this.#pos + length);
    this.#pos += length;
    return out;
  }

  async #fill(): Promise<void> {
    const chunk = new Uint8Array(4096);
    const n = await this.#conn.read(chunk);
    if (n === null) {
      throw new Error("Redis 连接已提前断开");
    }
    const unread = this.#buf.subarray(this.#pos);
    const next = new Uint8Array(unread.byteLength + n);
    next.set(unread, 0);
    next.set(chunk.subarray(0, n), unread.byteLength);
    this.#buf = next;
    this.#pos = 0;
  }
}

async function sendCommand(
  conn: Deno.Conn,
  reader: RespReader,
  args: readonly string[],
): Promise<RespValue> {
  await writeAll(conn, encodeRespCommand(args));
  return await reader.readValue();
}

function connectFailureHint(conn: ParsedRedisConnection): string {
  if (conn.host.toLowerCase() === "host.docker.internal") {
    return `（若在宿主机执行无法解析 host.docker.internal，` +
      `请在 .env.judge 配置指向同实例同库 DB ${conn.db} 的 REDIS_CHECK_URL，例如 127.0.0.1:${conn.port}/${conn.db}）`;
  }
  return "";
}

/**
 * 在单一连接上严格顺序执行 `AUTH`（如有）→ `SELECT <db>` → `EVAL`。
 *
 * 任一前置步骤失败即立即返回错误，绝不继续执行后续 `EVAL`；
 * 全流程受总超时 `timeoutMs` 约束并在结束或超时后关闭连接、清理计时器。
 */
export async function evalRedisScriptStrict(
  conn: ParsedRedisConnection,
  lua: string,
  keys: readonly string[],
  timeoutMs: number,
): Promise<RedisEvalOutcome> {
  const endpoint = `${conn.host}:${conn.port}`;
  if (timeoutMs <= 0) {
    return {
      ok: false,
      timedOut: true,
      message: `重置资源组配置锁失败：执行 Redis 重置命令超时（${endpoint}）`,
    };
  }

  let timedOut = false;
  let activeConn: Deno.Conn | null = null;

  let resolveTimeout: (() => void) | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    resolveTimeout = () => resolve("timeout");
  });

  const timer = setTimeout(() => {
    timedOut = true;
    if (activeConn !== null) {
      try {
        activeConn.close();
      } catch {
        // 忽略关闭异常
      }
      activeConn = null;
    }
    resolveTimeout?.();
  }, timeoutMs);

  try {
    const connectAttempt = (
      conn.tls
        ? Deno.connectTls({ hostname: conn.host, port: conn.port })
        : Deno.connect({ hostname: conn.host, port: conn.port })
    ).then(
      (c) => {
        // 若超时已触发后才完成握手，立即关闭套接字防止句柄泄漏。
        if (timedOut) {
          try {
            c.close();
          } catch {
            // 忽略关闭异常
          }
          return { kind: "timedOut" as const };
        }
        activeConn = c;
        return { kind: "connected" as const, conn: c };
      },
      (err) => ({ kind: "error" as const, error: err }),
    );

    const racedConnect = await Promise.race([connectAttempt, timeoutPromise]);
    if (racedConnect === "timeout" || racedConnect.kind === "timedOut") {
      return {
        ok: false,
        timedOut: true,
        message: `重置资源组配置锁失败：连接 Redis 超时（${endpoint}）`,
      };
    }
    if (racedConnect.kind === "error") {
      return {
        ok: false,
        timedOut: false,
        message: `重置资源组配置锁失败：无法连接 Redis（${endpoint}）${
          connectFailureHint(conn)
        }`,
      };
    }

    const socket = racedConnect.conn;
    const reader = new RespReader(socket);

    const runProtocol = async (): Promise<RedisEvalOutcome> => {
      // 1. 若配置了凭据，必须首先通过 AUTH 验证并收到 +OK。
      if (conn.username !== undefined || conn.password !== undefined) {
        const authArgs = conn.username !== undefined
          ? ["AUTH", conn.username, conn.password ?? ""]
          : ["AUTH", conn.password ?? ""];
        const authReply = await sendCommand(socket, reader, authArgs);
        if (authReply.type !== "simple" || authReply.value !== "OK") {
          return {
            ok: false,
            timedOut: false,
            message:
              `重置资源组配置锁失败：Redis 认证失败（${endpoint}，凭据不会显示）`,
          };
        }
      }

      // 2. 始终显式执行 SELECT（即使 DB 0 也能让未认证服务端触发 NOAUTH 并阻止误删）。
      const selectReply = await sendCommand(socket, reader, [
        "SELECT",
        String(conn.db),
      ]);
      if (selectReply.type !== "simple" || selectReply.value !== "OK") {
        if (
          selectReply.type === "error" &&
          /^NOAUTH\b/i.test(selectReply.message)
        ) {
          return {
            ok: false,
            timedOut: false,
            message:
              `重置资源组配置锁失败：Redis 需要认证，请检查连接凭据（${endpoint}）`,
          };
        }
        return {
          ok: false,
          timedOut: false,
          message:
            `重置资源组配置锁失败：Redis 切换数据库 DB ${conn.db} 失败（${endpoint}）`,
        };
      }

      // 3. 认证与选库全部确认成功后，方可在同连接上发送 EVAL。
      const evalReply = await sendCommand(socket, reader, [
        "EVAL",
        lua,
        String(keys.length),
        ...keys,
      ]);
      if (evalReply.type === "integer") {
        if (evalReply.value === 1) return { ok: true, cleared: true };
        if (evalReply.value === 0) return { ok: true, cleared: false };
      }
      if (evalReply.type === "error") {
        const firstLine = (evalReply.message.split(/\r?\n/)[0] ?? "").trim()
          .slice(0, 200);
        return {
          ok: false,
          timedOut: false,
          message:
            `重置资源组配置锁失败：Redis 执行脚本失败（${endpoint}）：${firstLine}`,
        };
      }
      return {
        ok: false,
        timedOut: false,
        message: `重置资源组配置锁失败：Redis 返回非预期响应（${endpoint}）`,
      };
    };

    try {
      const racedProtocol = await Promise.race([runProtocol(), timeoutPromise]);
      if (racedProtocol === "timeout" || timedOut) {
        return {
          ok: false,
          timedOut: true,
          message:
            `重置资源组配置锁失败：执行 Redis 重置命令超时（${endpoint}）`,
        };
      }
      return racedProtocol;
    } catch (err) {
      if (timedOut) {
        return {
          ok: false,
          timedOut: true,
          message:
            `重置资源组配置锁失败：执行 Redis 重置命令超时（${endpoint}）`,
        };
      }
      const detail = ((err as Error).message ?? "").split(/\r?\n/)[0]?.trim() ??
        "连接异常";
      return {
        ok: false,
        timedOut: false,
        message:
          `重置资源组配置锁失败：与 Redis（${endpoint}）通信异常：${detail}`,
      };
    }
  } finally {
    clearTimeout(timer);
    if (activeConn !== null) {
      try {
        (activeConn as Deno.Conn).close();
      } catch {
        // 忽略关闭异常
      }
      activeConn = null;
    }
  }
}
