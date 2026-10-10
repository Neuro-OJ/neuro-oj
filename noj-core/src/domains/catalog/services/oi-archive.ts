import { BadRequestError } from "../../../shared/base/errors.ts";
import type { ParsedProblemBundle } from "./bundle-parser.ts";

/** 每次操作拥有自己的 Worker；结束或异常后立即回收，不维护进程内队列或缓存。 */
async function processArchive<T>(operation: string, data: unknown): Promise<T> {
  const worker = new Worker(
    new URL("./oi-archive-worker.ts", import.meta.url).href,
    { type: "module" },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timeout = setTimeout(
        () => reject(new BadRequestError("题包处理超时，请减少数据量后重试")),
        120_000,
      );
      worker.onmessage = (event) => {
        if (event.data.ok) resolve(event.data.result);
        else reject(new BadRequestError(event.data.error));
      };
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new Error(`题包 Worker 失败：${event.message}`));
      };
      worker.postMessage({ operation, data });
    });
  } finally {
    clearTimeout(timeout);
    worker.terminate();
  }
}

/** 已发布旧题包的安全解压，不阻塞 HTTP 主线程。 */
export function readOiArchive(
  data: Uint8Array,
): Promise<Record<string, Uint8Array>> {
  return processArchive("read", data);
}

/** 导入预览也在独立 Worker 内完成路径、大小及 manifest 校验。 */
export function parseOiArchive(data: Uint8Array): Promise<ParsedProblemBundle> {
  return processArchive("parse", data);
}

/** 低压缩等级用于派生评测包，内容不变，CPU 开销更低。 */
export function buildOiArchive(
  data: Record<string, Uint8Array>,
): Promise<Uint8Array> {
  return processArchive("zip", data);
}
