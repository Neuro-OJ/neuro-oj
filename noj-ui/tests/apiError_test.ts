/**
 * utils/apiError.ts 单元测试。
 *
 * 覆盖四类错误提取：后端错误响应、无 error 字段兜底、网络错误、超时，
 * 以及未知错误兜底。
 */
/// <reference lib="deno.ns" />
import { assertEquals } from 'jsr:@std/assert@^1';
import { extractApiError, isNetworkError, isTimeoutError } from '../utils/apiError.ts';

/** 构造一个带 $fetch 错误对象结构的 Error（data/status 为 ofetch FetchError 字段） */
function makeFetchError(
  overrides: {
    data?: unknown;
    status?: number;
    statusCode?: number;
    message?: string;
    cause?: unknown;
  } = {},
): Error {
  const err = new Error(overrides.message ?? 'fetch error');
  Object.assign(err, { data: undefined, ...overrides });
  return err;
}

Deno.test('extractApiError: 后端错误响应提取 error/code/request_id', () => {
  const err = makeFetchError({
    data: { error: '用户名已存在', code: 'CONFLICT_ERROR', request_id: 'req-123' },
    status: 409,
  });
  const info = extractApiError(err);
  assertEquals(info.message, '用户名已存在');
  assertEquals(info.code, 'CONFLICT_ERROR');
  assertEquals(info.status, 409);
  assertEquals(info.requestId, 'req-123');
});

Deno.test('extractApiError: statusCode 字段兼容（NuxtError 形态）', () => {
  const err = makeFetchError({
    data: { error: '题目不存在' },
    statusCode: 404,
  });
  const info = extractApiError(err);
  assertEquals(info.message, '题目不存在');
  assertEquals(info.status, 404);
});

Deno.test('extractApiError: 无 error 字段时返回含状态码的结构化兜底', () => {
  const err = makeFetchError({ data: {}, status: 500 });
  const info = extractApiError(err);
  assertEquals(info.message, '请求失败（HTTP 500）');
  assertEquals(info.status, 500);
});

Deno.test('extractApiError: 响应体非 JSON（data 为字符串）时按状态码兜底', () => {
  const err = makeFetchError({ data: 'Internal Server Error', status: 502 });
  assertEquals(extractApiError(err).message, '请求失败（HTTP 502）');
});

Deno.test('extractApiError: 超时（AbortError）', () => {
  // ofetch timeout 触发：FetchError 的 cause 为 DOMException AbortError
  const cause = new DOMException('The operation was aborted due to timeout', 'AbortError');
  const err = makeFetchError({ cause });
  assertEquals(isTimeoutError(err), true);
  assertEquals(extractApiError(err).message, '请求超时，请稍后重试');
});

Deno.test('extractApiError: 原生 AbortError 名称判断', () => {
  const err = new DOMException('aborted', 'AbortError');
  assertEquals(isTimeoutError(err), true);
  assertEquals(extractApiError(err).message, '请求超时，请稍后重试');
});

Deno.test('extractApiError: 网络错误（TypeError fetch failed）', () => {
  const cause = new TypeError('fetch failed');
  const err = makeFetchError({ cause });
  assertEquals(isNetworkError(err), true);
  assertEquals(extractApiError(err).message, '网络连接失败，请检查网络');
});

Deno.test('extractApiError: 消息含 fetch failed 的网络错误', () => {
  const err = makeFetchError({ message: 'fetch failed' });
  assertEquals(isNetworkError(err), true);
  assertEquals(extractApiError(err).message, '网络连接失败，请检查网络');
});

Deno.test('extractApiError: 未知错误兜底', () => {
  assertEquals(extractApiError('oops').message, '操作失败，请稍后重试');
  assertEquals(extractApiError(null).message, '操作失败，请稍后重试');
  assertEquals(extractApiError(new Error('unknown')).message, '操作失败，请稍后重试');
});

Deno.test('extractApiError: 网络错误优先于状态码判断', () => {
  // 网络层错误即使带 status 也应归为网络问题
  const err = makeFetchError({
    message: 'fetch failed',
    status: 0,
  });
  assertEquals(extractApiError(err).message, '网络连接失败，请检查网络');
});
