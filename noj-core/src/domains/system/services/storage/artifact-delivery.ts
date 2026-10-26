import { NotFoundError } from "../../../../shared/base/errors.ts";
import { getStorageProvider } from "./factory.ts";

/** 调用者先验证原提交权限；本门面只传输已定位的学生产物。 */
export async function deliverStoredArtifact(url: string, fileName: string) {
  const storage = await getStorageProvider(), stat = await storage.stat(url);
  if (!stat.exists) throw new NotFoundError("提交产物暂不可用");
  const headers = new Headers({
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename*=UTF-8''${
      encodeURIComponent(fileName)
    }`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (stat.sizeBytes !== null) {
    headers.set("Content-Length", String(stat.sizeBytes));
  }
  return new Response(await storage.getStream(url), { headers });
}
