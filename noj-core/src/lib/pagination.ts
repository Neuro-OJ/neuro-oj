/**
 * 路由层分页参数解析（PR-6 抽取）。
 *
 * ## 背景（榜单 audit 发现）
 *
 * 多个路由（admin.ts / submissions.ts / search.ts / rankings.ts 等）有 4-6 行
 * 几乎相同的样板：
 *
 * ```ts
 * const pageRaw = c.req.query("page");
 * const page = parseInt(pageRaw ?? "1", 10);
 * if (!Number.isInteger(page) || page < 1) throw new ValidationError("page 必须为正整数");
 * const perPageRaw = c.req.query("per_page");
 * const perPage = Math.min(Math.max(parseInt(perPageRaw ?? "20", 10), 1), 100);
 * if (!Number.isInteger(perPage) || perPage < 1) throw new ValidationError("per_page 必须为正整数");
 * ```
 *
 * 各处差异仅在默认值 / 上限 / 字段名（page vs pageNum / perPage vs limit）。
 *
 * ## 用法
 *
 * ```ts
 * const { page, perPage } = parsePagination(c, { defaultPerPage: 20, maxPerPage: 100 });
 * ```
 *
 * 失败时抛 `ValidationError`，由 app.ts 统一 onError 转 400 JSON 响应。
 */

import type { Context } from "hono";
import { ValidationError } from "./errors.ts";

const DEFAULT_PAGE = 1;
const DEFAULT_PER_PAGE = 20;
const DEFAULT_MAX_PER_PAGE = 100;

/** parsePagination 配置项 */
export interface ParsePaginationOptions {
  /** 默认页码（默认 1） */
  defaultPage?: number;
  /** 默认每页条数（默认 20） */
  defaultPerPage?: number;
  /** 每页条数上限（默认 100） */
  maxPerPage?: number;
  /** query 中 page 字段名（默认 "page"） */
  pageField?: string;
  /** query 中 per_page 字段名（默认 "per_page"） */
  perPageField?: string;
}

/** parsePagination 返回值 */
export interface Pagination {
  /** 1-based 页码 */
  page: number;
  /** 每页条数（已 clamp 到 [1, maxPerPage]） */
  perPage: number;
  /** 跳过的记录数（用于 OFFSET） */
  offset: number;
}

/**
 * 从 Hono Context 提取并校验分页参数。
 *
 * 解析规则：
 * - 缺省：page=1, perPage=20
 * - perPage 自动 clamp 到 [1, maxPerPage]，无需手动校验
 * - page 必须 ≥ 1，否则 ValidationError（400）
 *
 * @throws {ValidationError} page 非正整数 / perPage 非正整数
 */
export function parsePagination(
  c: Context,
  options: ParsePaginationOptions = {},
): Pagination {
  const {
    defaultPage = DEFAULT_PAGE,
    defaultPerPage = DEFAULT_PER_PAGE,
    maxPerPage = DEFAULT_MAX_PER_PAGE,
    pageField = "page",
    perPageField = "per_page",
  } = options;

  const pageRaw = c.req.query(pageField);
  const page = pageRaw === undefined || pageRaw === ""
    ? defaultPage
    : parseInt(pageRaw, 10);

  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError(`${pageField} 必须为正整数`);
  }

  const perPageRaw = c.req.query(perPageField);
  // PR-6 评审修订：原 perPageRaw2 命名异味——perPageRaw 才是真正的 raw string。
  // 此处 parsedPerPage 是已 parseInt 后的数字，与下方 perPage 的 clamp 结果区分。
  const parsedPerPage = perPageRaw === undefined || perPageRaw === ""
    ? defaultPerPage
    : parseInt(perPageRaw, 10);

  if (!Number.isInteger(parsedPerPage) || parsedPerPage < 1) {
    throw new ValidationError(`${perPageField} 必须为正整数`);
  }

  const perPage = Math.min(parsedPerPage, maxPerPage);

  return {
    page,
    perPage,
    offset: (page - 1) * perPage,
  };
}

/** 统一分页响应结构 */
export interface PaginationMeta {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

/** 由 page/perPage/total 计算 total_pages + 构造 PaginationMeta */
export function buildPaginationMeta(
  page: number,
  perPage: number,
  total: number,
): PaginationMeta {
  return {
    page,
    per_page: perPage,
    total,
    total_pages: total === 0 ? 0 : Math.ceil(total / perPage),
  };
}
