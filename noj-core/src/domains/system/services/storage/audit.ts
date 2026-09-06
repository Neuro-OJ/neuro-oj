/**
 * 对象存储只读盘点。
 *
 * 该模块只比较“后端 inventory”和“数据库引用”，不会调用 delete、put 或
 * 修改数据库。生产环境应先保存报告并人工复核，再决定是否制定后续回收策略。
 */

import type { StorageObjectInfo } from "./types.ts";

export type StorageReferenceKind =
  | "support_package"
  | "artifact_submission"
  | "avatar"
  | "message_image";

export interface StorageReference {
  kind: StorageReferenceKind;
  recordId: string;
  column: string;
  url: string;
  provider: "local" | "s3";
  key: string;
}

export interface StorageAuditObject extends StorageObjectInfo {
  /** 根据 key 前缀推断的对象类型；local 内容寻址对象可能为 unknown。 */
  kind: StorageReferenceKind | "unknown";
}

export interface StorageAuditReport {
  generatedAt: string;
  provider: "local" | "s3";
  objectsTotal: number;
  objectsBytes: number;
  objectsBytesUnknown: number;
  referencedObjectsTotal: number;
  orphanObjectsTotal: number;
  orphanObjectsBytes: number;
  missingReferencesTotal: number;
  invalidReferencesTotal: number;
  byKind: Record<StorageReferenceKind | "unknown", {
    objects: number;
    bytes: number;
    references: number;
  }>;
  orphans: StorageAuditObject[];
  missingReferences: StorageReference[];
  invalidReferences: Array<{
    kind: StorageReferenceKind;
    recordId: string;
    column: string;
    url: string;
    reason: string;
  }>;
}

const KINDS: Array<StorageReferenceKind | "unknown"> = [
  "support_package",
  "artifact_submission",
  "avatar",
  "message_image",
  "unknown",
];

/** 从受控 key 前缀推断对象类型。 */
export function classifyStorageObjectKey(
  key: string,
): StorageReferenceKind | "unknown" {
  if (key.startsWith("packages/")) return "support_package";
  if (key.startsWith("artifacts/")) return "artifact_submission";
  if (key.startsWith("avatar/")) return "avatar";
  if (key.startsWith("message-images/")) return "message_image";
  return "unknown";
}

function emptyKinds(): StorageAuditReport["byKind"] {
  return Object.fromEntries(
    KINDS.map((kind) => [kind, { objects: 0, bytes: 0, references: 0 }]),
  ) as StorageAuditReport["byKind"];
}

/**
 * 对 inventory 与 DB 引用做确定性比较。
 *
 * 同一 key 被多个记录引用只计一个 referenced object；任何 orphan 仅报告，
 * 不暗示可以立即删除，因为 provider 可能存在跨环境/历史引用。
 */
export function buildStorageAuditReport(input: {
  generatedAt?: string;
  provider: "local" | "s3";
  objects: StorageObjectInfo[];
  references: StorageReference[];
  invalidReferences?: StorageAuditReport["invalidReferences"];
}): StorageAuditReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const objects = input.objects.map((object) => ({
    ...object,
    kind: classifyStorageObjectKey(object.key),
  }));
  const byKey = new Map(objects.map((object) => [object.key, object]));
  const references = input.references.filter((ref) =>
    ref.provider === input.provider
  );
  const referencedKeys = new Set(references.map((ref) => ref.key));
  const orphanObjects = objects.filter((object) =>
    !referencedKeys.has(object.key)
  );
  const missingReferences = references.filter((ref) => !byKey.has(ref.key));
  const byKind = emptyKinds();

  for (const object of objects) {
    const item = byKind[object.kind];
    item.objects++;
    if (object.sizeBytes !== null) item.bytes += object.sizeBytes;
  }
  for (const reference of references) {
    const item = byKind[classifyStorageObjectKey(reference.key)];
    item.references++;
  }

  const objectsBytes = objects.reduce(
    (total, object) => total + (object.sizeBytes ?? 0),
    0,
  );
  const orphanObjectsBytes = orphanObjects.reduce(
    (total, object) => total + (object.sizeBytes ?? 0),
    0,
  );

  return {
    generatedAt,
    provider: input.provider,
    objectsTotal: objects.length,
    objectsBytes,
    objectsBytesUnknown: objects.filter((object) => object.sizeBytes === null)
      .length,
    referencedObjectsTotal: referencedKeys.size,
    orphanObjectsTotal: orphanObjects.length,
    orphanObjectsBytes,
    missingReferencesTotal: missingReferences.length,
    invalidReferencesTotal: input.invalidReferences?.length ?? 0,
    byKind,
    orphans: orphanObjects,
    missingReferences,
    invalidReferences: input.invalidReferences ?? [],
  };
}

/** 将只读盘点结果导出为低基数 Prometheus gauges。 */
export function renderStorageAuditPrometheus(
  report: StorageAuditReport,
): string {
  const labels = `provider="${report.provider}"`;
  const lines = [
    `# HELP noj_storage_objects_total 当前对象总数（只读盘点）`,
    `# TYPE noj_storage_objects_total gauge`,
    `noj_storage_objects_total{${labels}} ${report.objectsTotal}`,
    `# HELP noj_storage_bytes 当前对象总字节数（只读盘点）`,
    `# TYPE noj_storage_bytes gauge`,
    `noj_storage_bytes{${labels}} ${report.objectsBytes}`,
    `# HELP noj_storage_referenced_objects 当前被数据库引用的对象数`,
    `# TYPE noj_storage_referenced_objects gauge`,
    `noj_storage_referenced_objects{${labels}} ${report.referencedObjectsTotal}`,
    `# HELP noj_storage_orphan_objects 当前未被数据库引用的对象数（仅报告）`,
    `# TYPE noj_storage_orphan_objects gauge`,
    `noj_storage_orphan_objects{${labels}} ${report.orphanObjectsTotal}`,
    `# HELP noj_storage_orphan_bytes 当前未被数据库引用对象的字节数（仅报告）`,
    `# TYPE noj_storage_orphan_bytes gauge`,
    `noj_storage_orphan_bytes{${labels}} ${report.orphanObjectsBytes}`,
    `# HELP noj_storage_missing_references 当前引用但 inventory 不存在的引用数`,
    `# TYPE noj_storage_missing_references gauge`,
    `noj_storage_missing_references{${labels}} ${report.missingReferencesTotal}`,
    `# HELP noj_storage_audit_generated_at_seconds 盘点报告生成时间`,
    `# TYPE noj_storage_audit_generated_at_seconds gauge`,
    `noj_storage_audit_generated_at_seconds{${labels}} ${
      Math.floor(Date.parse(report.generatedAt) / 1000)
    }`,
  ];
  return `${lines.join("\n")}\n`;
}
