/** 同一主机的独立部署可配置不同前缀；Cookie 本身不区分端口。 */
export function authCookieNames(prefix: string) {
  return { token: `${prefix}:token`, session: `${prefix}:session` };
}
