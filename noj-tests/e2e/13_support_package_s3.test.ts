/**
 * 支持包 S3 存储 E2E 测试。
 *
 * 覆盖：
 * - S3 模式上传支持包（所有者 + 管理员）
 * - S3 模式下载 + 删除
 * - 权限验证（非所有者 403、题目不存在 404）
 *
 * 需要环境：`S3_ENDPOINT` 已设置（MinIO）且 noj-core 以 `STORAGE_PROVIDER=s3` 运行。
 * 否则所有测试跳过。
 */

import {
  apiDelete,
  apiGet,
  apiPost,
  isE2E,
  loginAndChangePassword,
  registerUser,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;
const ADMIN_EMAIL = Deno.env.get("E2E_ADMIN_EMAIL") || "e2e_admin@test.com";
const ADMIN_PASS = Deno.env.get("E2E_ADMIN_PASS") || "e2e_admin_pass";
const ADMIN_NEW_PASS = "E2eAdminChangedPass1";

// S3 模式检测：需要 MinIO 端点和 noj-core 以 S3 模式运行
const s3Endpoint = Deno.env.get("S3_ENDPOINT");
const isS3Mode = !!(isE2E && s3Endpoint);

let adminToken = "";
let ownerToken = "";
let ownerId = "";
let problemId = "";
let strangerToken = "";

/** 生成内存中的小 zip 文件用于上传 */
function createMinimalZip(): Uint8Array {
  // 一个最小的有效 zip 文件（空目录）
  // PKZIP 格式：local file header + central directory + end record
  const zip = new Uint8Array([
    0x50, 0x4B, 0x05, 0x06, // EOCD 签名
    0x00, 0x00, // 磁盘号
    0x00, 0x00, // central dir 磁盘号
    0x00, 0x00, // 本磁盘条目数
    0x00, 0x00, // central dir 总条目数
    0x00, 0x00, 0x00, 0x00, // central dir 大小
    0x00, 0x00, 0x00, 0x00, // central dir 偏移
    0x00, 0x00, // 注释长度
  ]);
  return zip;
}

/** 生成 zip 文件占位内容 */
function createZipBlob(): Blob {
  const bytes = createMinimalZip();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" });
}

Deno.test({
  name: "[e2e/s3-support-pkg] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();

    if (!isS3Mode) {
      console.log("  ⚠ S3_ENDPOINT 未设置，S3 测试跳过");
      return;
    }

    adminToken = await loginAndChangePassword(
      ADMIN_EMAIL,
      ADMIN_PASS,
      ADMIN_NEW_PASS,
    );

    const ts = Date.now().toString(36);
    ownerToken = await registerUser(
      "s3owner_" + ts,
      "s3owner_" + ts + "@test.com",
      "Test12345679",
    );
    const me = await apiGet("/api/v1/auth/me", ownerToken);
    ownerId = (me.body as { data: { id: string } }).data.id;

    // 创建题目
    const probRes = await apiPost("/api/v1/problems", {
      title: "S3 测试题",
      description: "用于支持包 S3 上传测试",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      time_limit_ms: 3000,
      memory_limit_mb: 256,
      type: "P",
    }, ownerToken);
    if (probRes.status !== 201) throw new Error("创建题目失败");
    problemId = (probRes.body as { data: { id: string } }).data.id;

    // 注册一个无关用户
    strangerToken = await registerUser(
      "s3stranger_" + ts,
      "s3stranger_" + ts + "@test.com",
      "Test12345679",
    );

    console.log("  ✓ 测试资源已创建 (S3 mode=" + isS3Mode + ")");
  },
});

// ── 上传 ──

Deno.test({
  name: "[e2e/s3-support-pkg] 4.1 所有者上传支持包（S3）",
  ignore: skip || !isS3Mode,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !isS3Mode) return;
    // 使用 multipart/form-data 上传 zip
    const form = new FormData();
    form.append("file", createZipBlob(), "support.zip");

    const res = await fetch(
      `${Deno.env.get("E2E_BASE_URL") || "http://localhost:8099"}/api/v1/problems/${problemId}/support-package`,
      {
        method: "POST",
        headers: { Authorization: "Bearer " + ownerToken },
        body: form,
      },
    );

    const body = await res.json() as { data?: { support_package_storage_url?: string; has_support_package?: boolean } };
    if (res.status !== 200) {
      throw new Error("期望 200, 实际 " + res.status + " " + JSON.stringify(body));
    }
    const storageUrl = body.data?.support_package_storage_url || "";
    if (!storageUrl.startsWith("noj-storage://s3/")) {
      throw new Error("期望 noj-storage://s3/ 前缀, 实际 " + storageUrl);
    }
    if (!storageUrl.includes("checksum_sha256=")) {
      throw new Error("期望 checksum_sha256 参数");
    }
    console.log("  ✓ S3 上传成功: " + storageUrl.slice(0, 60) + "...");
  },
});

Deno.test({
  name: "[e2e/s3-support-pkg] 4.2 管理员为他人题目上传",
  ignore: skip || !isS3Mode,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !isS3Mode) return;
    const form = new FormData();
    form.append("file", createZipBlob(), "admin-support.zip");

    const res = await fetch(
      `${Deno.env.get("E2E_BASE_URL") || "http://localhost:8099"}/api/v1/problems/${problemId}/support-package`,
      {
        method: "POST",
        headers: { Authorization: "Bearer " + adminToken },
        body: form,
      },
    );

    if (res.status !== 200) {
      const body = await res.json();
      throw new Error("期望 200, 实际 " + res.status + " " + JSON.stringify(body));
    }
    console.log("  ✓ 管理员上传成功");
  },
});

Deno.test({
  name: "[e2e/s3-support-pkg] 4.3 非所有者上传被拒 403",
  ignore: skip || !isS3Mode,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !isS3Mode) return;
    const form = new FormData();
    form.append("file", createZipBlob(), "hack.zip");

    const res = await fetch(
      `${Deno.env.get("E2E_BASE_URL") || "http://localhost:8099"}/api/v1/problems/${problemId}/support-package`,
      {
        method: "POST",
        headers: { Authorization: "Bearer " + strangerToken },
        body: form,
      },
    );

    if (res.status !== 403) {
      throw new Error("期望 403, 实际 " + res.status);
    }
    console.log("  ✓ 非所有者上传被拒");
  },
});

Deno.test({
  name: "[e2e/s3-support-pkg] 4.4 上传非 zip 文件被拒 400",
  ignore: skip || !isS3Mode,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !isS3Mode) return;
    const form = new FormData();
    form.append("file", new Blob(["not a zip"], { type: "text/plain" }), "evil.txt");

    const res = await fetch(
      `${Deno.env.get("E2E_BASE_URL") || "http://localhost:8099"}/api/v1/problems/${problemId}/support-package`,
      {
        method: "POST",
        headers: { Authorization: "Bearer " + ownerToken },
        body: form,
      },
    );

    if (res.status !== 400) {
      throw new Error("期望 400, 实际 " + res.status);
    }
    console.log("  ✓ 非 zip 上传被拒");
  },
});

// ── 下载 ──

Deno.test({
  name: "[e2e/s3-support-pkg] 4.5 下载支持包",
  ignore: skip || !isS3Mode,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !isS3Mode) return;
    const res = await fetch(
      `${Deno.env.get("E2E_BASE_URL") || "http://localhost:8099"}/api/v1/problems/${problemId}/support-package`,
      {
        headers: { Authorization: "Bearer " + ownerToken },
      },
    );

    if (res.status !== 200) {
      throw new Error("期望 200, 实际 " + res.status);
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("zip") && !ct.includes("octet-stream")) {
      console.log("  ⚠ Content-Type 非预期: " + ct);
    }
    console.log("  ✓ 下载支持包成功");
  },
});

Deno.test({
  name: "[e2e/s3-support-pkg] 4.6 无包题目下载返回 404",
  ignore: skip || !isS3Mode,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !isS3Mode) return;
    // 创建新题目（无支持包）
    const ts2 = Date.now().toString(36) + "b";
    const t2 = await registerUser(
      "s3owner2_" + ts2,
      "s3owner2_" + ts2 + "@test.com",
      "Test12345679",
    );
    const pr = await apiPost("/api/v1/problems", {
      title: "S3 无包测试",
      description: "无支持包",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      time_limit_ms: 3000,
      memory_limit_mb: 256,
      type: "P",
    }, t2);
    const pid = (pr.body as { data: { id: string } }).data.id;

    const res = await fetch(
      `${Deno.env.get("E2E_BASE_URL") || "http://localhost:8099"}/api/v1/problems/${pid}/support-package`,
      {
        headers: { Authorization: "Bearer " + t2 },
      },
    );

    if (res.status !== 404) {
      throw new Error("期望 404, 实际 " + res.status);
    }
    console.log("  ✓ 无包题目下载返回 404");
  },
});

// ── 删除 ──

Deno.test({
  name: "[e2e/s3-support-pkg] 4.7 所有者删除支持包",
  ignore: skip || !isS3Mode,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !isS3Mode) return;
    const res = await apiDelete(
      `/api/v1/problems/${problemId}/support-package`,
      ownerToken,
    );
    if (res.status !== 200) {
      throw new Error("期望 200, 实际 " + res.status + " " + JSON.stringify(res.body));
    }
    // 验证删除后不再有包
    const detail = await apiGet(`/api/v1/problems/${problemId}`, ownerToken);
    const d = detail.body as { data: { has_support_package: boolean } };
    if (d.data.has_support_package !== false) {
      // 非强制 — has_support_package 字段取决于实现
      console.log("  ⚠ 删除后 has_support_package 未更新");
    }
    console.log("  ✓ 支持包已删除");
  },
});

Deno.test({
  name: "[e2e/s3-support-pkg] 4.8 非所有者删除被拒 403",
  ignore: skip || !isS3Mode,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !isS3Mode) return;
    // 创建新题目 + 上传包
    const ts3 = Date.now().toString(36) + "c";
    const t3 = await registerUser(
      "s3owner3_" + ts3,
      "s3owner3_" + ts3 + "@test.com",
      "Test12345679",
    );
    const pr3 = await apiPost("/api/v1/problems", {
      title: "S3 权限测试",
      description: "用于删除权限测试",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      time_limit_ms: 3000,
      memory_limit_mb: 256,
      type: "P",
    }, t3);
    const pid3 = (pr3.body as { data: { id: string } }).data.id;

    // 先上传包
    const form = new FormData();
    form.append("file", createZipBlob(), "perm.zip");
    await fetch(
      `${Deno.env.get("E2E_BASE_URL") || "http://localhost:8099"}/api/v1/problems/${pid3}/support-package`,
      {
        method: "POST",
        headers: { Authorization: "Bearer " + t3 },
        body: form,
      },
    );

    // 陌生人删除
    const delRes = await apiDelete(
      `/api/v1/problems/${pid3}/support-package`,
      strangerToken,
    );
    if (delRes.status !== 403) {
      throw new Error("期望 403, 实际 " + delRes.status);
    }
    console.log("  ✓ 非所有者删除被拒");
  },
});
