/**
 * 已下线接口的 410 合同：命中时返回替代接口与原因。
 *
 * 保留期限：v0.11 内保留，v0.12 删除本文件与 `retired-endpoints.json`（#698）。
 * 保留理由是 LMCC VS Code 插件由用户自行安装、升级滞后，旧版插件调用到已下线
 * 接口时需要明确提示；Web 前端、CLI 与 judge 随版本协调升级，不依赖本表。
 */
import type { Context, MiddlewareHandler } from "hono";
import retiredEndpoints from "./retired-endpoints.json" with { type: "json" };

export interface RetiredEndpoint {
  method: string;
  path: string;
  replacement: string;
  reason: string;
}

export const RETIRED_ENDPOINTS = retiredEndpoints as RetiredEndpoint[];

interface CompiledRetiredEndpoint {
  definition: RetiredEndpoint;
  pattern: RegExp;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compilePath(path: string): RegExp {
  const segments = path.split("/").map((segment) =>
    segment.startsWith(":") ? "[^/]+" : escapeRegExp(segment)
  );
  return new RegExp(`^${segments.join("/")}$`);
}

const COMPILED_ENDPOINTS: CompiledRetiredEndpoint[] = RETIRED_ENDPOINTS.map(
  (definition) => ({ definition, pattern: compilePath(definition.path) }),
);

/** 返回当前请求对应的退役合同；只按 method + path 匹配，不拦截同路径读取。 */
export function findRetiredEndpoint(
  method: string,
  path: string,
): RetiredEndpoint | undefined {
  const normalizedMethod = method.toUpperCase();
  return COMPILED_ENDPOINTS.find((entry) =>
    entry.definition.method.toUpperCase() === normalizedMethod &&
    entry.pattern.test(path)
  )?.definition;
}

function requestId(c: Context): string {
  return (c.get("requestId") as string | undefined) ?? crypto.randomUUID();
}

/** 生产组合根使用的旧默认域写入退役中间件。 */
export function retiredEndpointMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const endpoint = findRetiredEndpoint(c.req.method, c.req.path);
    if (!endpoint) return await next();
    return c.json(
      {
        error: "接口已退役，请使用显式工作空间入口",
        code: "ENDPOINT_RETIRED",
        method: endpoint.method,
        path: endpoint.path,
        replacement: endpoint.replacement,
        reason: endpoint.reason,
        request_id: requestId(c),
      },
      410,
    );
  };
}
