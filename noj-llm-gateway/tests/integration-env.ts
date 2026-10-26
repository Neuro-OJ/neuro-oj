/** 正式 Gateway 集成测试的显式资源变量。缺失时立即失败，禁止 ignored 假通过。 */
function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new Error(
      `Gateway 集成测试缺少 ${name}；请通过 test-launcher 提供本 run 隔离资源`,
    );
  }
  return value;
}

export const gatewayTestDatabaseUrl = required("NOJ_GATEWAY_TEST_DATABASE_URL");
export const gatewayTestRedisUrl = required("NOJ_GATEWAY_TEST_REDIS_URL");
export const gatewayTestRedisPrefix = required("NOJ_GATEWAY_TEST_REDIS_PREFIX");

export function runRedisPrefix(label: string): string {
  return `${gatewayTestRedisPrefix}${label}:${crypto.randomUUID()}:`;
}
