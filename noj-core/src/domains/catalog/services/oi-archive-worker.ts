/** 大题包的同步压缩/解压只在每次操作独立的 Worker 中执行。 */
import { zipSync } from "fflate";
import { parseBundleZip, readEvaluationEntries } from "./bundle-parser.ts";

type ArchiveRequest = { operation: "zip"; data: Record<string, Uint8Array> } | {
  operation: "read" | "parse";
  data: Uint8Array;
};
const workerScope = self as unknown as {
  onmessage: ((event: { data: ArchiveRequest }) => void) | null;
  postMessage(message: unknown): void;
};
workerScope.onmessage = (event) => {
  try {
    const { operation, data } = event.data;
    const result = operation === "zip"
      ? zipSync(data, { level: 1 })
      : operation === "parse"
      ? parseBundleZip(data)
      : readEvaluationEntries(data);
    workerScope.postMessage({ ok: true, result });
  } catch (error) {
    workerScope.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : "题包处理失败",
    });
  }
};
