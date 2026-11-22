/** SHA-256 十六进制摘要（Deno 原生，不 spawn 外部命令）。 */
export async function sha256Hex(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", input as BufferSource);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** 计算文件 SHA-256 十六进制摘要。 */
export async function fileSha256Hex(path: string): Promise<string> {
  const data = await Deno.readFile(path);
  return sha256Hex(data);
}
