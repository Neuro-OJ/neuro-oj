/** 判断收件人是否使用保留的 invalid 域名（包括其子域）。 */
export function isInvalidEmailAddress(email: string): boolean {
  const domain = email.trim().split("@").at(-1)?.toLowerCase().replace(
    /\.$/,
    "",
  );
  return domain === "invalid" || domain?.endsWith(".invalid") === true;
}
