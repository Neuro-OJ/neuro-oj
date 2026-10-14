/** 支持包真实 S3 验收：format 2 草稿导入、发布、权限与不可变版本引用守卫。 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { strToU8, unzipSync, zipSync } from "npm:fflate@0.8.2";
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3@3.1078.0";
import {
  api,
  BASE_URL,
  e2eTest,
  getAdminToken,
  isE2E,
  registerUser,
  TEST_PASSWORD,
  waitForServer,
} from "../helper.ts";

// 本地存储明确跳过；开启时仍检查 core 有效配置及真实对象，不能仅靠测试 env。
const isS3Mode = isE2E && Deno.env.get("STORAGE_PROVIDER") === "s3" &&
  !!Deno.env.get("S3_ENDPOINT");
const runtime = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 2000,
    memory_limit_mb: 512,
  },
};
interface Actors {
  admin: string;
  owner: string;
  ownerId: string;
  stranger: string;
}
let actorPromise: Promise<Actors> | undefined;

async function request<T>(
  method: string,
  path: string,
  token: string,
  status: number,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await api(method, `/api/v1${path}`, {
    token,
    body,
    headers,
  });
  assertEquals(
    response.status,
    status,
    `${method} ${path}: ${JSON.stringify(response.body)}`,
  );
  return response.body as T;
}
function actors(): Promise<Actors> {
  return actorPromise ??= (async () => {
    await waitForServer();
    const admin = await getAdminToken();
    const settings = await request<
      { data: { key: string; effective_value: unknown }[] }
    >("GET", "/admin/system/settings", admin, 200);
    assertEquals(
      settings.data.find((s) => s.key === "storage_provider")!.effective_value,
      "s3",
    );
    const suffix = `${Date.now().toString(36)}${
      crypto.randomUUID().slice(0, 4)
    }`;
    const owner = await registerUser(
      `pkg_owner_${suffix}`,
      `pkg_owner_${suffix}@test.com`,
      TEST_PASSWORD,
    );
    const stranger = await registerUser(
      `pkg_other_${suffix}`,
      `pkg_other_${suffix}@test.com`,
      TEST_PASSWORD,
    );
    const me = await request<{ data: { id: string } }>(
      "GET",
      "/auth/me",
      owner,
      200,
    );
    await request(
      "PUT",
      `/domains/main/members/${me.data.id}/roles`,
      admin,
      200,
      { roles: ["editor"] },
    );
    const workspace = await request<
      { data: { platform_admin: boolean; permissions: string[] } }
    >("GET", "/domains/main", owner, 200);
    assertEquals(workspace.data.platform_admin, false);
    assert(workspace.data.permissions.includes("problem:write_own"));
    // 默认 evaluator command、不联网，不需要给作者平台敏感字段权限。
    return { admin, owner, ownerId: me.data.id, stranger };
  })();
}
function bundle(marker: string) {
  return zipSync({
    "problem.json": strToU8(
      JSON.stringify({
        format_version: 2,
        title: "支持包 S3 验收",
        difficulty: "easy",
        runtime_config: runtime,
      }),
    ),
    "statement.md": strToU8("支持包草稿与不可变版本。"),
    "evaluate.py": strToU8(
      "print('---RESULT---')\nprint('{\"score\": 100}')\n",
    ),
    "submission_template.py": strToU8("def solve(value):\n    return value\n"),
    "visible.jsonl": strToU8('{"input":"1","output":"1"}\n'),
    "hidden.jsonl": strToU8('{"input":"2","output":"2"}\n'),
    "marker.txt": strToU8(marker),
  });
}
async function importBundle(
  token: string,
  path: string,
  bytes: Uint8Array,
  status: number,
  revision?: number,
  filename = "problem.zip",
) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: "application/zip" }),
    filename,
  );
  const response = await fetch(`${BASE_URL}/api/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(revision === undefined ? {} : { "If-Match": String(revision) }),
    },
    body: form,
  });
  const body = await response.json();
  assertEquals(response.status, status, `${path}: ${JSON.stringify(body)}`);
  return body as {
    data: { problem_id: string; number: number; draft_revision: number };
  };
}
async function createPackage(marker = "version-a") {
  const people = await actors();
  const imported = await importBundle(
    people.owner,
    "/domains/main/problems/import-bundle",
    bundle(marker),
    201,
  );
  const problemPath = `/domains/main/problems/${imported.data.number}`;
  return {
    ...people,
    problemId: imported.data.problem_id,
    problemPath,
    revision: imported.data.draft_revision,
  };
}
type PackageFixture = Awaited<ReturnType<typeof createPackage>>;
async function draft(f: PackageFixture) {
  return await request<{ revision: number }>(
    "GET",
    `${f.problemPath}/draft`,
    f.owner,
    200,
  );
}
async function publish(f: PackageFixture, actor = f.owner) {
  const current = await draft(f);
  return await request<
    { version_id: string; version: number; draft_revision: number }
  >("POST", `${f.problemPath}/publish`, actor, 200, {
    change_note: "S3 支持包验收",
  }, { "If-Match": String(current.revision) });
}
async function storageUrl(f: PackageFixture) {
  const detail = await request<
    { data: { owner_id: string; support_package_storage_url: string | null } }
  >("GET", `/problems/${f.problemId}`, f.owner, 200);
  assertEquals(detail.data.owner_id, f.ownerId);
  const url = detail.data.support_package_storage_url;
  assert(
    typeof url === "string" && url.startsWith("noj-storage://s3/"),
    "core 必须实际保存 S3 对象",
  );
  assert(
    /^[0-9a-f]{64}$/.test(
      new URL(url).searchParams.get("checksum_sha256") ?? "",
    ),
  );
  return url;
}
async function download(f: PackageFixture, actor = f.owner) {
  const response = await fetch(
    `${BASE_URL}/api/v1/problems/${f.problemId}/support-package`,
    { headers: { Authorization: `Bearer ${actor}` } },
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "application/zip");
  return new Uint8Array(await response.arrayBuffer());
}
function marker(bytes: Uint8Array) {
  return new TextDecoder().decode(unzipSync(bytes)["marker.txt"]);
}

// 隔离 MinIO 运维凭据只读核对物理对象，不作为普通用户下载入口。
async function operatorRead(url: string) {
  const accessKeyId = Deno.env.get("S3_ACCESS_KEY"),
    secretAccessKey = Deno.env.get("S3_SECRET_KEY");
  assert(accessKeyId && secretAccessKey, "S3 实际验收必须提供隔离 MinIO 凭据");
  const client = new S3Client({
    endpoint: Deno.env.get("S3_ENDPOINT")!,
    region: Deno.env.get("S3_REGION") ?? "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  const Bucket = Deno.env.get("S3_BUCKET") ?? "noj-support-packages",
    Key = decodeURIComponent(new URL(url).pathname.slice(1));
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket, Key }));
    const object = await client.send(new GetObjectCommand({ Bucket, Key }));
    assert(object.Body);
    const bytes = await object.Body.transformToByteArray();
    assertEquals(head.ContentLength, bytes.length);
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    );
    const checksum = Array.from(hash, (b) => b.toString(16).padStart(2, "0"))
      .join("");
    assertEquals(checksum, new URL(url).searchParams.get("checksum_sha256"));
    return bytes;
  } finally {
    client.destroy();
  }
}

e2eTest(
  "[e2e/s3-support-pkg] 1 普通main editor导入草稿，显式发布后绑定真实S3对象",
  async () => {
    const f = await createPackage();
    await request("GET", f.problemPath, f.stranger, 404);
    assertEquals((await draft(f)).revision, 1);
    await publish(f);
    const bytes = await download(f);
    assertEquals(marker(bytes), "version-a");
    assertEquals(bytes, await operatorRead(await storageUrl(f)));
    assertEquals("problem.json" in unzipSync(bytes), false);
  },
  !isS3Mode,
);
e2eTest(
  "[e2e/s3-support-pkg] 2 管理员更新他人草稿，发布前不改变原版本支持包",
  async () => {
    const f = await createPackage();
    await publish(f);
    const before = await storageUrl(f), current = await draft(f);
    await importBundle(
      f.admin,
      `${f.problemPath}/import-bundle`,
      bundle("admin-version-b"),
      200,
      current.revision,
    );
    assertEquals(marker(await download(f)), "version-a");
    assertEquals(await storageUrl(f), before);
    await publish(f, f.admin);
    assertNotEquals(await storageUrl(f), before);
    assertEquals(marker(await download(f)), "admin-version-b");
  },
  !isS3Mode,
);
e2eTest(
  "[e2e/s3-support-pkg] 3 非作者不能修改或下载支持包，不存在题目返回404",
  async () => {
    const f = await createPackage();
    await publish(f);
    const current = await draft(f);
    await importBundle(
      f.stranger,
      `${f.problemPath}/import-bundle`,
      bundle("forbidden"),
      403,
      current.revision,
    );
    await request(
      "GET",
      `/problems/${f.problemId}/support-package`,
      f.stranger,
      403,
    );
    await request(
      "GET",
      `/problems/${crypto.randomUUID()}/support-package`,
      f.owner,
      404,
    );
    assertEquals((await draft(f)).revision, current.revision);
    assertEquals(marker(await download(f)), "version-a");
  },
  !isS3Mode,
);
e2eTest(
  "[e2e/s3-support-pkg] 4 草稿更新需要If-Match，旧revision及非ZIP拒绝且不改变内容",
  async () => {
    const f = await createPackage();
    await publish(f);
    const current = await draft(f);
    await importBundle(
      f.owner,
      `${f.problemPath}/import-bundle`,
      bundle("missing-revision"),
      428,
    );
    await importBundle(
      f.owner,
      `${f.problemPath}/import-bundle`,
      bundle("stale-revision"),
      409,
      current.revision - 1,
    );
    await importBundle(
      f.owner,
      `${f.problemPath}/import-bundle`,
      strToU8("not a zip"),
      400,
      current.revision,
      "invalid.txt",
    );
    assertEquals((await draft(f)).revision, current.revision);
    assertEquals(marker(await download(f)), "version-a");
  },
  !isS3Mode,
);
e2eTest(
  "[e2e/s3-support-pkg] 5 core代理下载与S3原始字节、长度、SHA256一致",
  async () => {
    const f = await createPackage("download-proof");
    await publish(f);
    const upstream = await operatorRead(await storageUrl(f));
    assertEquals(await download(f), upstream);
    assertEquals(marker(upstream), "download-proof");
  },
  !isS3Mode,
);
e2eTest(
  "[e2e/s3-support-pkg] 6 无支持包题目由授权作者下载返回404",
  async () => {
    const people = await actors();
    const created = await request<{ problem_id: string }>(
      "POST",
      "/domains/main/problems",
      people.owner,
      201,
      {
        title: "S3 无包题",
        description: "尚未导入支持包",
        runtime_config: runtime,
      },
    );
    await request(
      "GET",
      `/problems/${created.problem_id}/support-package`,
      people.owner,
      404,
    );
  },
  !isS3Mode,
);
e2eTest(
  "[e2e/s3-support-pkg] 7 删除草稿引用需要revision，历史V1/V2包仍由引用守卫保留",
  async () => {
    const f = await createPackage("historical-v1");
    const v1 = await publish(f),
      url1 = await storageUrl(f),
      current = await draft(f);
    await importBundle(
      f.owner,
      `${f.problemPath}/import-bundle`,
      bundle("historical-v2"),
      200,
      current.revision,
    );
    await publish(f);
    const url2 = await storageUrl(f),
      editing = await draft(f),
      deletePath = `/problems/${f.problemId}/support-package`;
    await request("DELETE", deletePath, f.owner, 428);
    await request("DELETE", deletePath, f.owner, 409, undefined, {
      "If-Match": String(editing.revision - 1),
    });
    await request("DELETE", deletePath, f.owner, 200, undefined, {
      "If-Match": String(editing.revision),
    });
    assertEquals((await draft(f)).revision, editing.revision + 1);
    assertEquals(marker(await download(f)), "historical-v2");
    const emptyVersion = await publish(f);
    assertEquals(emptyVersion.version, 3);
    await request("GET", deletePath, f.owner, 404);
    const oldVersion = await request<{ data: { is_latest: boolean } }>(
      "GET",
      `/problems/${f.problemId}/versions/${v1.version_id}`,
      f.owner,
      200,
    );
    assertEquals(oldVersion.data.is_latest, false);
    assertEquals(marker(await operatorRead(url1)), "historical-v1");
    assertEquals(marker(await operatorRead(url2)), "historical-v2");
  },
  !isS3Mode,
);
e2eTest(
  "[e2e/s3-support-pkg] 8 非作者不能删除支持包，版本与S3对象保持原样",
  async () => {
    const f = await createPackage();
    await publish(f);
    const url = await storageUrl(f), current = await draft(f);
    await request(
      "DELETE",
      `/problems/${f.problemId}/support-package`,
      f.stranger,
      403,
      undefined,
      { "If-Match": String(current.revision) },
    );
    assertEquals((await draft(f)).revision, current.revision);
    assertEquals(await storageUrl(f), url);
    assertEquals(marker(await operatorRead(url)), "version-a");
  },
  !isS3Mode,
);
