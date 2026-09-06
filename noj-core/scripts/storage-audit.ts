/**
 * 只读对象存储盘点。
 *
 * 用法：
 *   deno task storage:audit
 *   deno task storage:audit -- --output /tmp/storage-audit.json \
 *     --prometheus-output /var/lib/node_exporter/textfile/noj_storage.prom
 *
 * 脚本只执行数据库 SELECT 与 provider 的 listObjects，不执行删除或写入。
 */

import { dirname } from "jsr:@std/path@^1";
import { getDb } from "../src/shared/db/connection.ts";
import {
  messages,
  problems,
  submissions,
  users,
} from "../src/shared/db/schema.ts";
import {
  getStorageProvider,
  getStorageProviderKind,
  initSystemSettings,
} from "../src/domains/system/index.ts";
import {
  buildStorageAuditReport,
  renderStorageAuditPrometheus,
  type StorageAuditReport,
  type StorageReference,
  type StorageReferenceKind,
} from "../src/domains/system/services/storage/audit.ts";
import { parseStorageUrl } from "../src/domains/system/services/storage/types.ts";

interface Options {
  output?: string;
  prometheusOutput?: string;
  pretty: boolean;
}

function parseArgs(args: string[]): Options {
  const options: Options = { pretty: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--pretty") {
      options.pretty = true;
    } else if (arg === "--output" || arg === "--prometheus-output") {
      const value = args[++i];
      if (!value) throw new Error(`${arg} 需要路径参数`);
      if (arg === "--output") options.output = value;
      else options.prometheusOutput = value;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return options;
}

function addReference(
  references: StorageReference[],
  invalidReferences: StorageAuditReport["invalidReferences"],
  kind: StorageReferenceKind,
  recordId: string,
  column: string,
  url: string | null,
): void {
  if (!url) return;
  try {
    const parsed = parseStorageUrl(url);
    references.push({
      kind,
      recordId,
      column,
      url,
      provider: parsed.provider,
      key: parsed.key,
    });
  } catch (err) {
    invalidReferences.push({
      kind,
      recordId,
      column,
      url,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

async function collectReferences(): Promise<{
  references: StorageReference[];
  invalidReferences: StorageAuditReport["invalidReferences"];
}> {
  const db = getDb();
  const [problemRows, submissionRows, userRows, messageRows] = await Promise
    .all([
      db.select({ id: problems.id, url: problems.support_package_storage_url })
        .from(problems),
      db.select({ id: submissions.id, url: submissions.artifact_storage_url })
        .from(submissions),
      db.select({ id: users.id, url: users.avatar_url }).from(users),
      db.select({ id: messages.id, url: messages.image_url }).from(messages),
    ]);
  const references: StorageReference[] = [];
  const invalidReferences: StorageAuditReport["invalidReferences"] = [];
  for (const row of problemRows) {
    addReference(
      references,
      invalidReferences,
      "support_package",
      row.id,
      "problems.support_package_storage_url",
      row.url,
    );
  }
  for (const row of submissionRows) {
    addReference(
      references,
      invalidReferences,
      "artifact_submission",
      row.id,
      "submissions.artifact_storage_url",
      row.url,
    );
  }
  for (const row of userRows) {
    addReference(
      references,
      invalidReferences,
      "avatar",
      row.id,
      "users.avatar_url",
      row.url,
    );
  }
  for (const row of messageRows) {
    addReference(
      references,
      invalidReferences,
      "message_image",
      row.id,
      "messages.image_url",
      row.url,
    );
  }
  return { references, invalidReferences };
}

async function writeText(path: string, content: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
}

const options = parseArgs(Deno.args);
// storage_provider 属于 runtime 设置；独立 CLI 运行时显式加载 DB 缓存，
// 避免仅按 env/default 盘点错 provider。
await initSystemSettings();
const configuredProvider = getStorageProviderKind();
const storage = await getStorageProvider();
if (!storage.listObjects) {
  throw new Error("当前 StorageProvider 不支持只读对象列举");
}
const [{ references, invalidReferences }, objects] = await Promise.all([
  collectReferences(),
  storage.listObjects(),
]);
const report = buildStorageAuditReport({
  provider: configuredProvider,
  objects,
  references,
  invalidReferences,
});
const json = JSON.stringify(report, null, options.pretty ? 2 : undefined) +
  "\n";
if (options.output) await writeText(options.output, json);
if (options.prometheusOutput) {
  await writeText(
    options.prometheusOutput,
    renderStorageAuditPrometheus(report),
  );
}
if (!options.output) await Deno.stdout.write(new TextEncoder().encode(json));
if (options.output) {
  console.log(`对象存储盘点报告已写入: ${options.output}`);
}
if (options.prometheusOutput) {
  console.log(`对象存储 Prometheus 指标已写入: ${options.prometheusOutput}`);
}
