import https from "node:https";
import http from "node:http";
import { Readable } from "node:stream";
/**
 * Provider 上游地址出站校验（审计 G-03）。
 *
 * llm-gateway 是唯一同时接入评测网络与内网的服务：若 Provider 的 `base_url` 可指向
 * 内网 / 回环 / 云元数据地址，沙箱触发 LLM 调用即可让网关代为访问内网 HTTP 服务，
 * 且响应体原样回传（SSRF → 横向移动）。BYOK 时期的外网白名单函数随 BYOK 一并删除，
 * 本模块恢复该控制，分两道：
 *
 * 1. **登记时**（`assertSafeBaseUrl`）：仅允许 https、禁止 URL 内嵌凭据、
 *    禁止内网主机名与内网 IP 字面量；
 * 2. **调用时**（`assertResolvesPublic`）：请求上游前解析 DNS，任一 A/AAAA 记录落在
 *    内网即拒绝，防止"公网域名解析到内网 IP"绕过登记校验。
 *
 * 显式白名单 `NOJ_LLM_UPSTREAM_ALLOWED_HOSTS` 中的主机免除以上限制（允许 http 与内网
 * 地址），用于内网自建模型与 E2E mock。
 */

/** 上游地址不合规时抛出的错误码（路由层原样返回）。 */
export const UPSTREAM_BLOCKED = "provider_base_url_blocked";

/** 被视为内网/本机的主机名后缀与精确名。 */
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal"]);

/** 解析逗号分隔的白名单 env 为小写主机名集合。 */
export function parseAllowedHosts(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(
      Boolean,
    ),
  );
}

/** 去掉 IPv6 字面量的方括号。 */
function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function parseIpv4(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

function isPrivateIpv4([a, b, c]: number[]): boolean {
  return a === 0 || // 0.0.0.0/8 本网络
    a === 10 || // 10/8
    a === 127 || // 回环
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) || // 链路本地 / 云元数据
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0/24 协议分配、192.0.2/24 文档
    a >= 224; // 组播与保留
}

/** 把 IPv6 文本展开为 8 组 16 位整数；非法时返回 null。 */
function parseIpv6(host: string): number[] | null {
  if (!host.includes(":")) return null;
  let text = host;
  // 末尾内嵌 IPv4（如 ::ffff:10.0.0.1）转为两组十六进制
  const v4 = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    const p = parseIpv4(v4[1]);
    if (!p) return null;
    text = text.slice(0, -v4[1].length) +
      `${((p[0] << 8) | p[1]).toString(16)}:${
        ((p[2] << 8) | p[3]).toString(16)
      }`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  const nums = groups.map((g) =>
    /^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN
  );
  return nums.some(Number.isNaN) ? null : nums;
}

function isPrivateIpv6(g: number[]): boolean {
  const allZero = g.slice(0, 7).every((x) => x === 0);
  if (allZero && (g[7] === 0 || g[7] === 1)) return true; // :: 与 ::1
  // IPv4 映射 / 兼容地址：按内嵌 IPv4 判定
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isPrivateIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  return (g[0] & 0xfe00) === 0xfc00 || // fc00::/7 唯一本地
    (g[0] & 0xffc0) === 0xfe80 || // fe80::/10 链路本地
    (g[0] & 0xff00) === 0xff00 || // 组播
    (g[0] === 0x64 && g[1] === 0xff9b); // 64:ff9b::/96 NAT64（可映射到内网 IPv4）
}

/** 判断 IP 字面量是否属于内网 / 本机 / 保留地址；非 IP 返回 false。 */
export function isPrivateAddress(address: string): boolean {
  const host = bareHost(address);
  const v4 = parseIpv4(host);
  if (v4) return isPrivateIpv4(v4);
  const v6 = parseIpv6(host);
  if (v6) return isPrivateIpv6(v6);
  return false;
}

function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}

/**
 * 登记时校验 Provider `base_url`。
 *
 * @throws {Error} message 为 `UPSTREAM_BLOCKED` 时表示地址不合规。
 */
export function assertSafeBaseUrl(
  baseUrl: string,
  allowedHosts: Set<string>,
): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(UPSTREAM_BLOCKED);
  }
  if (url.username || url.password) throw new Error(UPSTREAM_BLOCKED);
  const host = bareHost(url.hostname);
  if (allowedHosts.has(host)) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(UPSTREAM_BLOCKED);
    }
    return;
  }
  if (url.protocol !== "https:") throw new Error(UPSTREAM_BLOCKED);
  if (isIpLiteral(host)) {
    if (isPrivateAddress(host)) throw new Error(UPSTREAM_BLOCKED);
    return;
  }
  if (
    BLOCKED_HOSTS.has(host) ||
    BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) ||
    !host.includes(".") // 单段名：Docker 服务名 / 内网短名
  ) {
    throw new Error(UPSTREAM_BLOCKED);
  }
}

/** node:http/https 的薄封装：允许测试注入，避免真实网络。 */
export type RequestFn = typeof import("node:https").request;
let httpsRequest: RequestFn = https.request;
let httpRequest: RequestFn = http.request;
/** 测试注入请求实现。 */
export function setRequestImplementations(
  https: RequestFn,
  http: RequestFn,
): void {
  httpsRequest = https;
  httpRequest = http;
}

/** 恢复默认请求实现（测试收尾用，防止跨用例污染）。 */
export function resetRequestImplementations(): void {
  httpsRequest = https.request;
  httpRequest = http.request;
}

/** DNS 解析函数（可注入，便于测试）。 */
export type ResolveFn = (
  host: string,
  type: "A" | "AAAA",
) => Promise<string[]>;

const defaultResolve: ResolveFn = (host, type) => Deno.resolveDns(host, type);

/**
 * 调用时校验：解析上游主机的 A/AAAA 记录，任一落在内网即拒绝。
 *
 * 白名单主机与 IP 字面量（已在登记时校验）跳过解析。两类记录均解析失败时拒绝
 * （无法证明目标为公网，按失败关闭处理）。
 *
 * @throws {Error} message 为 `UPSTREAM_BLOCKED` 时表示目标不允许访问。
 */
export async function assertResolvesPublic(
  baseUrl: string,
  allowedHosts: Set<string>,
  resolve: ResolveFn = defaultResolve,
): Promise<void> {
  // 先复用登记时规则：存量 Provider 可能在本校验上线前登记
  assertSafeBaseUrl(baseUrl, allowedHosts);
  const host = bareHost(new URL(baseUrl).hostname);
  if (allowedHosts.has(host) || isIpLiteral(host)) return;
  const results = await Promise.allSettled([
    resolve(host, "A"),
    resolve(host, "AAAA"),
  ]);
  const addresses = results.flatMap((r) =>
    r.status === "fulfilled" ? r.value : []
  );
  if (addresses.length === 0) throw new Error(UPSTREAM_BLOCKED);
  if (addresses.some(isPrivateAddress)) throw new Error(UPSTREAM_BLOCKED);
}

/**
 * 出站校验结果：允许连接的**已验证地址集合**。
 *
 * 2026-11-02 rc/v0.11 审计 R1：旧实现只校验 DNS 解析结果，之后由 `fetch` 用原
 * hostname 重新解析并连接 —— 校验对象与连接对象不是同一批地址（DNS rebinding /
 * TOCTOU）。这里把已验证地址返回给调用方，由 {@link fetchPinned} 把连接**钉在**
 * 这批地址上，检查与连接因此绑定。
 */
export interface PublicResolution {
  /** 已验证为公网的地址；空数组表示该 host 无需固定（白名单或 IP 字面量）。 */
  addresses: string[];
  /** 去除方括号的裸 host。 */
  host: string;
}

/**
 * 校验出站目标并返回可用于固定连接的地址集合。
 *
 * 白名单主机与 IP 字面量不做 DNS 校验（登记时已校验），返回空地址集合表示
 * "按原样连接"。
 */
export async function resolvePublicUpstream(
  baseUrl: string,
  allowedHosts: Set<string>,
  resolve: ResolveFn = defaultResolve,
): Promise<PublicResolution> {
  assertSafeBaseUrl(baseUrl, allowedHosts);
  const host = bareHost(new URL(baseUrl).hostname);
  if (allowedHosts.has(host) || isIpLiteral(host)) {
    return { addresses: [], host };
  }
  const results = await Promise.allSettled([
    resolve(host, "A"),
    resolve(host, "AAAA"),
  ]);
  const resolved = results.flatMap((r) =>
    r.status === "fulfilled" ? r.value : []
  );
  // A/AAAA 可能返回重叠地址（双栈主机常见），去重后再返回：地址集合是
  // "已验证可连接"的集合，重复项没有语义，也会让调用方误以为存在备用地址。
  const addresses = [...new Set(resolved)];
  if (addresses.length === 0) throw new Error(UPSTREAM_BLOCKED);
  if (addresses.some(isPrivateAddress)) throw new Error(UPSTREAM_BLOCKED);
  return { addresses, host };
}

/**
 * 固定连接传输层签名。默认实现是 {@link nodePinnedTransport}；测试可注入替身，
 * 让既有 `stubFetch` 风格的用例继续拦截上游请求（生产路径始终是默认实现）。
 */
export type PinnedTransport = (
  url: string,
  init: RequestInit,
  resolution: PublicResolution,
) => Promise<Response>;

let pinnedTransport: PinnedTransport = nodePinnedTransport;

/** 注入固定连接传输层（测试用；不传参数恢复默认实现）。 */
export function setPinnedTransport(transport?: PinnedTransport): void {
  pinnedTransport = transport ?? nodePinnedTransport;
}

/**
 * 用**已校验地址**发起 HTTP(S) 请求，返回与会话一致的 `Response`。
 *
 * @param url 完整上游 URL
 * @param init 与 fetch 兼容的请求参数（method/headers/body/signal）
 * @param resolution {@link resolvePublicUpstream} 的结果
 */
export async function fetchPinned(
  url: string,
  init: RequestInit,
  resolution: PublicResolution,
): Promise<Response> {
  return await pinnedTransport(url, init, resolution);
}

/**
 * 默认传输层：node:http/https + 自定义 `lookup`。
 *
 * 关键点：
 * - `lookup` 把连接固定到 {@link PublicResolution.addresses} 里的地址，连接阶段
 *   不再解析 DNS（消除 rebinding 窗口）；
 * - 保留 `servername`（SNI）与原 Host 头，因此 TLS 证书仍按真实主机名校验；
 * - 3xx 一律拒绝，等价于原先 `fetch(..., { redirect: "error" })` 的语义；
 * - 响应体以 Web Stream 透传，SSE 流式输出不受影响。
 */
async function nodePinnedTransport(
  url: string,
  init: RequestInit,
  resolution: PublicResolution,
): Promise<Response> {
  const target = new URL(url);
  const isTls = target.protocol === "https:";
  if (!isTls && target.protocol !== "http:") {
    throw new Error(UPSTREAM_BLOCKED);
  }
  const host = bareHost(target.hostname);
  // 选第一个已验证地址；连接失败不再回退到其它地址（避免绕过验证语义）
  const pinned = resolution.addresses[0];
  const body = init.body === undefined || init.body === null
    ? undefined
    : typeof init.body === "string"
    ? init.body
    : init.body instanceof Uint8Array
    ? init.body
    : String(init.body);
  const headers = new Headers(init.headers);
  if (body !== undefined && !headers.has("content-length")) {
    headers.set(
      "content-length",
      String(typeof body === "string" ? body.length : body.byteLength),
    );
  }
  return await new Promise<Response>((resolve, reject) => {
    const lookup = pinned === undefined ? undefined : ((
      _host: string,
      options: { all?: boolean } | number,
      callback: (...args: unknown[]) => void,
    ) => {
      const all = typeof options === "object" && options !== null &&
        options.all === true;
      const family = pinned.includes(":") ? 6 : 4;
      if (all) callback(null, [{ address: pinned, family }]);
      else callback(null, pinned, family);
    }) as never;
    const request = (isTls ? httpsRequest : httpRequest)({
      protocol: target.protocol,
      host,
      port: target.port === "" ? (isTls ? 443 : 80) : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers),
      // SNI 与证书校验都用真实主机名
      servername: isTls ? host : undefined,
      lookup,
      signal: init.signal ?? undefined,
    }, (incoming) => {
      const status = incoming.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        // 与 redirect: "error" 等价：不跟随、也不把跳转目标当成上游响应
        incoming.resume();
        reject(new Error(UPSTREAM_BLOCKED));
        return;
      }
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(name, item);
        } else responseHeaders.set(name, String(value));
      }
      const stream = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(
        new Response(init.method === "HEAD" ? null : stream, {
          status,
          statusText: incoming.statusMessage ?? "",
          headers: responseHeaders,
        }),
      );
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}
