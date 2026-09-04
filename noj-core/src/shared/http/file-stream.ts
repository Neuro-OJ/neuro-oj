/**
 * multipart 大文件流工具。
 *
 * 将 busboy 的 Node Readable 文件流立即落盘到临时文件，并返回一个从该临时文件
 * 读取的 Web ReadableStream。
 *
 * 这样无论 `problem_id` 字段在文件之前还是之后到达，busboy 都不会因文件流未被消费
 * 而暂停（文件数据被立即写入磁盘），从根本上避免大文件 multipart 死锁；同时内存占用
 * 保持 O(1)（只读临时文件分块）。
 */
export function createFileStream(
  file: import("node:stream").Readable,
): ReadableStream<Uint8Array> {
  const spoolPromise = (async () => {
    const tmpPath = await Deno.makeTempFile({ suffix: ".zip" });
    const out = await Deno.open(tmpPath, {
      write: true,
      create: true,
      truncate: true,
    });
    try {
      for await (const chunk of file) {
        await out.write(chunk as Uint8Array);
      }
    } finally {
      out.close();
    }
    return tmpPath;
  })();

  let handle: Deno.FsFile | null = null;
  let tmpPath = "";
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!handle) {
          tmpPath = await spoolPromise;
          handle = await Deno.open(tmpPath, { read: true });
        }
        const buf = new Uint8Array(64 * 1024);
        const n = await handle.read(buf);
        if (n === null) {
          controller.close();
          await handle.close();
          await Deno.remove(tmpPath).catch(() => {});
          handle = null;
        } else {
          controller.enqueue(buf.subarray(0, n));
        }
      } catch (err) {
        controller.error(err);
        if (handle) {
          try {
            handle.close();
          } catch {
            // ignore
          }
          handle = null;
        }
        if (tmpPath) {
          await Deno.remove(tmpPath).catch(() => {});
        }
      }
    },
    cancel() {
      if (handle) {
        try {
          handle.close();
        } catch {
          // ignore
        }
        handle = null;
      }
      if (tmpPath) {
        Deno.remove(tmpPath).catch(() => {});
      }
      file.destroy();
    },
  });
}
