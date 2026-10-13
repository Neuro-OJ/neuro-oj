import { logger } from "../../../../shared/base/logging.ts";
import {
  listDomainStorageBaselineObjects,
  listDomainStorageReconciliationDomains,
  listExpiredDomainStorageUploads,
  reconcileDomainStorageCounters,
  releaseDomainStorageUpload,
  settleDomainStorageUpload,
} from "../../../workspace/index.ts";
import {
  collectStorageReferences,
  deleteStorageObject,
  registerLegacyStorageObject,
  verifyStorageObject,
} from "./registry.ts";

/** 有限批次核实存量大小、处理崩溃上传和刷新域计量；重复执行读取当前事实。 */
export async function reconcileDomainStorageBatch(limit = 100) {
  let verified = 0, recovered = 0, domains = 0, failed = 0;
  const run = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      failed++;
      logger.warn("域存储核对失败，保留持久依据以重试", {
        error_type: error instanceof Error ? error.name : "Error",
      });
    }
  };
  for (const row of await listDomainStorageBaselineObjects(limit)) {
    await run(async () => {
      await registerLegacyStorageObject(row.storage_url);
      await verifyStorageObject(row.storage_url);
      verified++;
    });
  }
  for (const upload of await listExpiredDomainStorageUploads(limit)) {
    await run(async () => {
      const url = upload.storage_url!;
      const state = await verifyStorageObject(url);
      const references = await collectStorageReferences(url);
      if (state === "ready" && references.total > 0) {
        await settleDomainStorageUpload(upload.domain_id, upload.id, url);
      } else {
        const deleted = await deleteStorageObject(url);
        if (deleted.outcome === "referenced") return;
        await releaseDomainStorageUpload(upload.domain_id, upload.id);
      }
      recovered++;
    });
  }
  for (const row of await listDomainStorageReconciliationDomains(limit)) {
    await run(async () => {
      await reconcileDomainStorageCounters(row.id);
      domains++;
    });
  }
  return { verified, recovered, domains, failed };
}

/** 仅保存关闭句柄；业务状态在数据库，多副本重复核对不会重复计量。 */
export function startDomainStorageReconciliation() {
  const controller = new AbortController();
  const done = (async () => {
    while (!controller.signal.aborted) {
      try {
        await reconcileDomainStorageBatch();
      } catch (error) {
        logger.warn("域存储核对批次失败，将重试", {
          error_type: error instanceof Error ? error.name : "Error",
        });
      }
      if (controller.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const cancel = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          controller.signal.removeEventListener("abort", cancel);
          resolve();
        }, 30_000);
        controller.signal.addEventListener("abort", cancel, { once: true });
      });
    }
  })();
  return { stop: () => controller.abort(), done };
}
