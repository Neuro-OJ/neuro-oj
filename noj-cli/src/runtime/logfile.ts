/** 进程日志文件路径：${runDir}/logs/<component>.log。 */
export function logPath(runDir: string, component: string): string {
  return `${runDir}/logs/${component}.log`;
}

/** 读文件末尾最多 maxBytes 字节；文件缺失返回空串。 */
export async function readRecentLog(
  path: string,
  maxBytes: number,
): Promise<string> {
  try {
    const info = await Deno.stat(path);
    if (!info.isFile) return "";
    const size = info.size;
    const start = Math.max(0, size - maxBytes);
    const f = await Deno.open(path, { read: true });
    try {
      await f.seek(start, Deno.SeekMode.Start);
      const buf = new Uint8Array(size - start);
      const n = await f.read(buf);
      return new TextDecoder().decode(buf.subarray(0, n ?? 0));
    } finally {
      f.close();
    }
  } catch {
    return "";
  }
}

/**
 * 从文件末尾开始轮询新内容，按行回调 onLine。
 * signal.aborted 为 true 时退出。轮询间隔 100ms。
 */
export async function followLogFile(
  path: string,
  onLine: (line: string) => void,
  signal: { aborted: boolean },
): Promise<void> {
  let offset = 0;
  try {
    const info = await Deno.stat(path);
    if (info.isFile) offset = info.size;
  } catch {
    // 文件尚不存在：从 0 开始，等待创建
  }
  let buf = "";
  while (!signal.aborted) {
    try {
      const info = await Deno.stat(path);
      if (info.isFile && info.size > offset) {
        const f = await Deno.open(path, { read: true });
        try {
          await f.seek(offset, Deno.SeekMode.Start);
          const chunk = new Uint8Array(info.size - offset);
          const n = await f.read(chunk);
          offset += n ?? 0;
          buf += new TextDecoder().decode(chunk.subarray(0, n ?? 0));
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (line.endsWith("\r")) onLine(line.slice(0, -1));
            else onLine(line);
          }
        } finally {
          f.close();
        }
      }
    } catch {
      // 文件被删/不可读：忽略，继续轮询
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (buf.length > 0) onLine(buf);
}
