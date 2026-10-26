import { logger } from "../../../../shared/base/logging.ts";
import type { ManagedTask } from "../../../../shared/runtime/managed-task.ts";
import { startPeriodicTask } from "../../../../shared/runtime/managed-task.ts";
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

/** 轮询间隔：30 秒。 */
const DOMAIN_STORAGE_RECONCILIATION_INTERVAL_MS = 30_000;

/** 当前任务（单例；stop 后到 done 完成期间仍保留，防止关闭中重复启动）。 */
let _domainStorageTask: ManagedTask | null = null;

/**
 * 启动域存储核对周期任务（单例）。
 *
 * 仅保存关闭句柄；业务状态在数据库，多副本重复核对不会重复计量。
 * `stop()` 清定时器，`done` 等待正在执行的那一批结束；done 完成后可再次启动。
 */
export function startDomainStorageReconciliation(): ManagedTask {
  if (_domainStorageTask !== null) return _domainStorageTask;
  const task = startPeriodicTask({
    name: "domain-storage-reconciliation",
    intervalMs: DOMAIN_STORAGE_RECONCILIATION_INTERVAL_MS,
    runImmediately: true,
    run: () => reconcileDomainStorageBatch().then(() => undefined),
    onError: (error) => {
      logger.warn("域存储核对批次失败，将重试", {
        error_type: error instanceof Error ? error.name : "Error",
      });
    },
  });
  _domainStorageTask = task;
  void task.done.then(() => {
    if (_domainStorageTask === task) _domainStorageTask = null;
  });
  return task;
}

/** 测试用：停止当前单例（done 完成前仍阻止重叠启动）。 */
export function _resetDomainStorageReconciliationForTest(): void {
  _domainStorageTask?.stop();
}
