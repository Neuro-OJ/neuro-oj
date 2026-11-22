/**
 * 法律合规（PIPL）E2E 剧本。
 *
 * 覆盖完整链路：
 * 1. 注册硬门槛：未带 `accepted_legal` → 400；带 → 成功且库内写入同意。
 * 2. 政策版本化：管理员发布重大版本 → 登录用户 `/auth/me` 的 `legal`
 *    `needs_consent=true`；同意后变 false。
 * 3. 非重大版本不触发重新同意。
 *
 * 前置：管理员 token 来自 seed（`getAdminToken`）；政策文档需先发布。
 */

import {
  api,
  apiPatch,
  apiPost,
  apiPut,
  e2eTest,
  getAdminToken,
  registerUser,
} from "../helper.ts";

interface LegalStatus {
  required_version: number;
  agreed_version: number;
  needs_consent: boolean;
  is_material: boolean;
}

interface MePayload {
  data?: { legal?: Record<string, LegalStatus> };
}

/** 以管理员身份发布一份文档版本。 */
async function publishVersion(
  adminToken: string,
  kind: string,
  content: string,
  isMaterial: boolean,
  summary: string | null,
) {
  const res = await apiPost(
    `/api/v1/admin/legal/documents/${kind}/versions`,
    { content, is_material: isMaterial, change_summary: summary },
    adminToken,
  );
  if (res.status !== 201) {
    throw new Error(
      `发布 ${kind} 版本失败: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return (res.body as { data: { version: number } }).data.version;
}

/** 读取当前用户的法律同意状态。 */
async function getLegal(token: string): Promise<Record<string, LegalStatus>> {
  const res = await api("GET", "/api/v1/auth/me", { token });
  const body = res.body as MePayload;
  return body.data?.legal ?? {};
}

e2eTest("legal-e2e: 未同意法律条款的注册被拒绝", async () => {
  const ts = Date.now();
  const res = await apiPost("/api/v1/auth/register", {
    username: `legal_no_${ts}`,
    email: `legal_no_${ts}@e2e.com`,
    password: "TestPass1234",
    // 故意不带 accepted_legal
  });
  if (res.status !== 400) {
    throw new Error(`未同意时注册应 400，实际 ${res.status}`);
  }
});

e2eTest("legal-e2e: 同意注册后库内写入同意记录并可导出", async () => {
  const ts = Date.now();
  const adminToken = await getAdminToken();

  // 先发布两份政策，使注册时能记录同意版本
  await publishVersion(
    adminToken,
    "privacy",
    `# 隐私政策 (${ts})`,
    true,
    "初始",
  );
  await publishVersion(adminToken, "terms", `# 服务条款 (${ts})`, true, "初始");

  const token = await registerUser(
    `legal_yes_${ts}`,
    `legal_yes_${ts}@e2e.com`,
    "TestPass1234",
  );

  // 个人信息导出（PIPL 查阅/复制权）应可用，且含 privacy+terms 两条同意记录
  const exportRes = await api("GET", "/api/v1/users/me/data-export", { token });
  if (exportRes.status !== 200) {
    throw new Error(`数据导出应 200，实际 ${exportRes.status}`);
  }
  const exportBody = exportRes.body as {
    data?: {
      account?: { username?: string };
      consents?: Array<{ document_kind: string }>;
    };
  };
  if (exportBody.data?.account?.username !== `legal_yes_${ts}`) {
    throw new Error("导出内容不含本人账户");
  }
  const kinds = (exportBody.data?.consents ?? []).map((c) => c.document_kind)
    .sort();
  if (kinds.join(",") !== "privacy,terms") {
    throw new Error(`导出应含 privacy+terms 同意记录，实际 ${kinds.join(",")}`);
  }
});

e2eTest("legal-e2e: 重大版本触发重新同意，非重大不触发", async () => {
  const ts = Date.now();
  const adminToken = await getAdminToken();

  // 先发布两个文档的初始重大版本（保证注册时能记录同意）
  const privacyV1 = await publishVersion(
    adminToken,
    "privacy",
    `# 隐私政策 v1 (${ts})`,
    true,
    "初始版本",
  );

  const token = await registerUser(
    `legal_flow_${ts}`,
    `legal_flow_${ts}@e2e.com`,
    "TestPass1234",
  );

  // 注册后：已同意当前重大版本 → 无需同意
  const afterRegister = await getLegal(token);
  if (afterRegister.privacy?.needs_consent === true) {
    throw new Error("注册后不应要求重新同意初始版本");
  }

  // 发布非重大新版本 → 仍不触发
  await publishVersion(
    adminToken,
    "privacy",
    `# 隐私政策 v2-typo (${ts})`,
    false,
    "修正错别字",
  );
  const afterNonMaterial = await getLegal(token);
  if (afterNonMaterial.privacy?.needs_consent === true) {
    throw new Error("非重大修订不应触发重新同意");
  }

  // 发布重大新版本 → 触发
  const v3 = await publishVersion(
    adminToken,
    "privacy",
    `# 隐私政策 v3 (${ts})`,
    true,
    "重大条款变更",
  );
  const afterMaterial = await getLegal(token);
  if (afterMaterial.privacy?.needs_consent !== true) {
    throw new Error("重大变更应触发重新同意");
  }
  if (afterMaterial.privacy?.required_version !== v3) {
    throw new Error(
      `required_version 应为 ${v3}，实际 ${afterMaterial.privacy?.required_version}`,
    );
  }

  // 用户同意 → needs_consent 变 false
  const consentRes = await apiPost(
    "/api/v1/legal/consent",
    { kind: "privacy" },
    token,
  );
  if (consentRes.status !== 201) {
    throw new Error(`同意端点应 201，实际 ${consentRes.status}`);
  }
  const afterConsent = await getLegal(token);
  if (afterConsent.privacy?.needs_consent !== false) {
    throw new Error("同意后应不再要求重新同意");
  }

  // 版本历史保留（不可变）
  const versionsRes = await api(
    "GET",
    "/api/v1/legal/documents/privacy/versions",
  );
  const versionsBody = versionsRes.body as {
    data?: Array<{ version: number }>;
  };
  const versions = versionsBody.data ?? [];
  const hasV1 = versions.some((v) => v.version === privacyV1);
  if (!hasV1) throw new Error("版本历史应保留初始版本");
});

e2eTest("legal-e2e: 删除/更正请求全生命周期与状态机", async () => {
  const ts = Date.now();
  const adminToken = await getAdminToken();
  const token = await registerUser(
    `legal_req_${ts}`,
    `legal_req_${ts}@e2e.com`,
    "TestPass1234",
  );

  // 提交请求
  const create = await apiPost(
    "/api/v1/legal/data-requests",
    {
      kind: "delete",
      target_type: "post",
      target_id: "post-123",
      detail: "请删除我的帖子",
    },
    token,
  );
  if (create.status !== 201) {
    throw new Error(`提交请求应 201，实际 ${create.status}`);
  }
  const requestId = (create.body as { data: { id: string } }).data.id;

  // 本人可见 + 状态 pending
  const mine = await api("GET", "/api/v1/legal/data-requests", { token });
  const mineRows =
    (mine.body as { data: Array<{ id: string; status: string }> }).data;
  const row = mineRows.find((r) => r.id === requestId);
  if (!row || row.status !== "pending") {
    throw new Error("本人请求应可见且为 pending");
  }

  // 管理端可见
  const adminList = await api("GET", "/api/v1/admin/legal/data-requests", {
    token: adminToken,
  });
  if (adminList.status !== 200) {
    throw new Error(`管理端请求列表应 200，实际 ${adminList.status}`);
  }

  // 状态机：pending → processing → resolved
  const toProcessing = await apiPatch(
    `/api/v1/admin/legal/data-requests/${requestId}`,
    { status: "processing" },
    adminToken,
  );
  if (toProcessing.status !== 200) {
    throw new Error(`受理应 200，实际 ${toProcessing.status}`);
  }
  const toResolved = await apiPatch(
    `/api/v1/admin/legal/data-requests/${requestId}`,
    { status: "resolved", resolution: "已删除" },
    adminToken,
  );
  if (toResolved.status !== 200) {
    throw new Error(`办结应 200，实际 ${toResolved.status}`);
  }

  // 终态后非法回退应被拒
  const illegal = await apiPatch(
    `/api/v1/admin/legal/data-requests/${requestId}`,
    { status: "pending" },
    adminToken,
  );
  // 断言具体拒绝码（400/409），避免 500 等异常被「!==200」宽松放过
  if (illegal.status !== 400 && illegal.status !== 409) {
    throw new Error(
      `resolved 后回退到 pending 应以 400/409 拒绝，实际 ${illegal.status}`,
    );
  }
});

e2eTest("legal-e2e: 未认证用户不能提交删除/更正请求", async () => {
  const res = await apiPost("/api/v1/legal/data-requests", {
    kind: "delete",
    target_type: "post",
    detail: "x",
  });
  if (res.status !== 401) {
    throw new Error(`未认证提交请求应 401，实际 ${res.status}`);
  }
});

e2eTest("legal-e2e: /site/meta 暴露处理者信息且不含敏感项", async () => {
  const adminToken = await getAdminToken();
  const ts = Date.now();

  // 读取原值，测试结束后还原，避免污染全局配置
  const before = await api("GET", "/api/v1/site/meta");
  const originalOperator =
    ((before.body as { data: { operator_name?: string } }).data
      ?.operator_name) ?? "";

  try {
    await apiPut(
      "/api/v1/admin/system/settings/legal_operator_name",
      { value: `示例社团 ${ts}` },
      adminToken,
    );

    const res = await api("GET", "/api/v1/site/meta");
    if (res.status !== 200) {
      throw new Error(`/site/meta 应 200，实际 ${res.status}`);
    }
    const data = (res.body as { data: Record<string, unknown> }).data;
    if (data.operator_name !== `示例社团 ${ts}`) {
      throw new Error("处理者名称未公开");
    }
    if ("tsa_root_cert" in data) {
      throw new Error("secret 项 tsa_root_cert 不应出现在公开端点");
    }
  } finally {
    await apiPut(
      "/api/v1/admin/system/settings/legal_operator_name",
      { value: originalOperator },
      adminToken,
    );
  }
});
