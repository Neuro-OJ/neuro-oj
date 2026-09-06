const MAX_REPORT_BYTES = 16 * 1024;
const ACCEPTED_CONTENT_TYPES = new Set([
  'application/csp-report',
  'application/reports+json',
  'application/json',
]);

/**
 * 接收浏览器 CSP Report-Only 报告。
 *
 * 报告只用于后续策略收紧，不写入业务数据库，也不回显请求内容。严格限制
 * 方法、媒体类型和请求体大小，避免把报告端点变成任意 JSON 接收器。
 */
export default defineEventHandler(async (event) => {
  const contentType = (getRequestHeader(event, 'content-type') ?? '')
    .split(';', 1)[0] ?? ''
    .trim()
    .toLowerCase();
  if (!ACCEPTED_CONTENT_TYPES.has(contentType)) {
    throw createError({
      statusCode: 415,
      statusMessage: 'Unsupported Media Type',
    });
  }

  const rawBody = await readRawBody(event);
  if (
    !rawBody || new TextEncoder().encode(rawBody).byteLength > MAX_REPORT_BYTES
  ) {
    throw createError({
      statusCode: 413,
      statusMessage: 'Payload Too Large',
    });
  }

  try {
    const payload: unknown = JSON.parse(rawBody);
    if (payload === null || typeof payload !== 'object') {
      throw new Error('CSP report must be a JSON object');
    }
  } catch {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid CSP report',
    });
  }

  setHeader(event, 'cache-control', 'no-store');
  setResponseStatus(event, 204);
  return null;
});
