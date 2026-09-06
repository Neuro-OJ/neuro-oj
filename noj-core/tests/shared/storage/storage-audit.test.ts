import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  buildStorageAuditReport,
  classifyStorageObjectKey,
  renderStorageAuditPrometheus,
  type StorageReference,
} from "../../../src/domains/system/services/storage/audit.ts";

Deno.test("storage audit: 按引用识别 orphan、缺失引用并汇总容量", () => {
  const references: StorageReference[] = [
    {
      kind: "support_package",
      recordId: "p1",
      column: "problems.support_package_storage_url",
      url: "noj-storage://s3/packages/p1.zip",
      provider: "s3",
      key: "packages/p1.zip",
    },
    {
      kind: "avatar",
      recordId: "u1",
      column: "users.avatar_url",
      url: "noj-storage://s3/avatar/u1.png",
      provider: "s3",
      key: "avatar/u1.png",
    },
    // 同一对象被重复引用，referencedObjectsTotal 仍只计一次。
    {
      kind: "avatar",
      recordId: "u2",
      column: "users.avatar_url",
      url: "noj-storage://s3/avatar/u1.png",
      provider: "s3",
      key: "avatar/u1.png",
    },
    {
      kind: "artifact_submission",
      recordId: "sub-missing",
      column: "submissions.artifact_storage_url",
      url: "noj-storage://s3/artifacts/missing.zip",
      provider: "s3",
      key: "artifacts/missing.zip",
    },
  ];
  const report = buildStorageAuditReport({
    generatedAt: "2026-09-06T00:00:00.000Z",
    provider: "s3",
    objects: [
      { key: "packages/p1.zip", sizeBytes: 10, lastModified: null },
      { key: "avatar/u1.png", sizeBytes: 20, lastModified: null },
      {
        key: "message-images/c1/orphan.jpg",
        sizeBytes: 30,
        lastModified: null,
      },
    ],
    references,
  });

  assertEquals(report.objectsTotal, 3);
  assertEquals(report.objectsBytes, 60);
  assertEquals(report.referencedObjectsTotal, 3);
  assertEquals(report.orphanObjectsTotal, 1);
  assertEquals(report.orphanObjectsBytes, 30);
  assertEquals(report.missingReferencesTotal, 1);
  assertEquals(report.byKind.avatar.references, 2);
  assertEquals(report.orphans[0].key, "message-images/c1/orphan.jpg");
  assertEquals(report.missingReferences[0].recordId, "sub-missing");
});

Deno.test("storage audit: inventory 只读 Prometheus 输出含容量和时间", () => {
  const report = buildStorageAuditReport({
    generatedAt: "2026-09-06T00:00:00.000Z",
    provider: "local",
    objects: [{ key: "hash", sizeBytes: null, lastModified: null }],
    references: [],
  });
  const output = renderStorageAuditPrometheus(report);
  assert(output.includes('noj_storage_objects_total{provider="local"} 1'));
  assert(output.includes('noj_storage_bytes{provider="local"} 0'));
  assert(output.includes('noj_storage_orphan_objects{provider="local"} 1'));
  assert(output.includes("noj_storage_audit_generated_at_seconds"));
});

Deno.test("storage audit: key 前缀类型可确定，内容寻址 key 保持 unknown", () => {
  assertEquals(classifyStorageObjectKey("packages/p.zip"), "support_package");
  assertEquals(
    classifyStorageObjectKey("artifacts/a.zip"),
    "artifact_submission",
  );
  assertEquals(classifyStorageObjectKey("avatar/u.png"), "avatar");
  assertEquals(
    classifyStorageObjectKey("message-images/c/m.jpg"),
    "message_image",
  );
  assertEquals(classifyStorageObjectKey("abc123"), "unknown");
});

Deno.test("storage governance manifest: 覆盖所有数据库对象引用且默认只读", async () => {
  const manifestUrl = new URL(
    "../../../../dev-docs/engineering/object-storage-governance.json",
    import.meta.url,
  );
  const manifest = JSON.parse(await Deno.readTextFile(manifestUrl)) as {
    phase: string;
    automatic_delete_policy: string;
    references_scanned_by: string[];
    object_types: Array<{ id: string; reference: string }>;
  };
  assertEquals(manifest.phase, "inventory-only");
  assertEquals(manifest.automatic_delete_policy, "no-new-policy");
  for (
    const reference of [
      "problems.support_package_storage_url",
      "submissions.artifact_storage_url",
      "users.avatar_url",
      "messages.image_url",
    ]
  ) {
    assert(manifest.references_scanned_by.includes(reference));
    assert(manifest.object_types.some((item) => item.reference === reference));
  }
});
