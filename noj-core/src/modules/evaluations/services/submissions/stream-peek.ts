/**
 * 上传流首块探测工具（artifact / prediction 共用）。
 *
 * 提交文件在落存储前需要先读头部做魔数校验，但流只能消费一次。本模块把首个
 * chunk 「预支」出来校验，同时返回一个把它重新放回队首的可重放流，供
 * `putStream` 继续消费，避免整包读入内存或复制同一段探测逻辑。
 *
 * @module
 */

/**
 * 从 web stream 读取首个 chunk，并返回可重新播放的流。
 *
 * 返回的 `rest` 会把 `first` 先 enqueue，再继续转发原流剩余数据；调用方应把
 * `rest`（而非原流）交给存储层。空流返回 `first = 空数组` 与立即关闭的 `rest`。
 *
 * @param stream 待探测的字节流
 * @returns 首块字节与可重放剩余流
 */
export async function peekFirstChunk(
  stream: ReadableStream<Uint8Array>,
): Promise<{ first: Uint8Array; rest: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const { done, value } = await reader.read();
  if (done) {
    return {
      first: new Uint8Array(0),
      rest: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    };
  }
  const first = value ?? new Uint8Array(0);
  let firstPending = true;
  const rest = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (firstPending) {
        firstPending = false;
        controller.enqueue(first);
        return;
      }
      const r = await reader.read();
      if (r.done) {
        controller.close();
        reader.releaseLock();
      } else if (r.value && r.value.length > 0) {
        controller.enqueue(r.value);
      }
    },
    cancel() {
      reader.releaseLock();
    },
  });
  return { first, rest };
}
