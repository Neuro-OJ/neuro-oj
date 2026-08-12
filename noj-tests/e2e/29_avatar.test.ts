/**
 * 用户头像 E2E 测试（issue #229）。
 *
 * 覆盖验收标准：
 * 1. 上传/替换/删除头像全流程
 * 2. 超限文件与非法类型被拒（400）
 * 3. 无头像用户展示默认头像（GET 404 → 前端 UserIdentity 占位）
 */

import { BASE_URL } from "./helper.ts";
import {
  apiDelete,
  apiGet,
  e2eTest,
  registerUser,
  TEST_PASSWORD,
} from "./helper.ts";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
]);
const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

function avatarForm(name: string, type: string, data: Uint8Array): FormData {
  const fd = new FormData();
  fd.append("file", new File([data], name, { type }));
  return fd;
}

async function uploadAvatar(
  token: string,
  fd: FormData,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}/api/v1/users/me/avatar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // 非 JSON 响应
  }
  return { status: res.status, body };
}

e2eTest("头像：上传/替换/删除全流程", async () => {
  const ts = Date.now();
  const username = `avatar_${ts}`;
  const token = await registerUser(username, `${username}@test.com`, TEST_PASSWORD);

  // 当前用户 id
  const me = await apiGet("/api/v1/auth/me", token);
  const userId = (me.body as { data: { id: string } }).data.id;

  // 1. 无头像默认展示：GET 404（前端 UserIdentity 渲染首字母占位）
  const none = await apiGet(`/api/v1/users/${userId}/avatar`);
  if (none.status !== 404) {
    throw new Error(`无头像应 404，实际 ${none.status}`);
  }

  // 2. 上传 png
  const up = await uploadAvatar(
    token,
    avatarForm("a.png", "image/png", PNG_BYTES),
  );
  if (up.status !== 200) {
    throw new Error(`上传失败: ${up.status} ${JSON.stringify(up.body)}`);
  }
  const avatarUrl = (up.body as { data: { avatar_url: string } }).data
    .avatar_url;
  if (!avatarUrl.startsWith("noj-storage://")) {
    throw new Error(`avatar_url 格式错误: ${avatarUrl}`);
  }

  // 3. 公开展示：Content-Type 与字节正确
  const show = await fetch(`${BASE_URL}/api/v1/users/${userId}/avatar`);
  if (show.status !== 200) {
    throw new Error(`展示失败: ${show.status}`);
  }
  const showType = show.headers.get("content-type");
  if (showType !== "image/png") {
    throw new Error(`Content-Type 应为 image/png，实际 ${showType}`);
  }
  const showBytes = new Uint8Array(await show.arrayBuffer());
  if (showBytes.length !== PNG_BYTES.length) {
    throw new Error("展示字节与上传不一致");
  }

  // 4. 替换为 jpeg
  const rep = await uploadAvatar(
    token,
    avatarForm("b.jpg", "image/jpeg", JPEG_BYTES),
  );
  if (rep.status !== 200) {
    throw new Error(`替换失败: ${rep.status} ${JSON.stringify(rep.body)}`);
  }
  const show2 = await fetch(`${BASE_URL}/api/v1/users/${userId}/avatar`);
  if (show2.headers.get("content-type") !== "image/jpeg") {
    throw new Error("替换后 Content-Type 应为 image/jpeg");
  }

  // 5. 删除（幂等）
  const del1 = await apiDelete("/api/v1/users/me/avatar", token);
  if (del1.status !== 204) {
    throw new Error(`删除失败: ${del1.status} ${JSON.stringify(del1.body)}`);
  }
  const del2 = await apiDelete("/api/v1/users/me/avatar", token);
  if (del2.status !== 204) {
    throw new Error("重复删除应幂等 204");
  }
  const gone = await apiGet(`/api/v1/users/${userId}/avatar`);
  if (gone.status !== 404) {
    throw new Error(`删除后应 404，实际 ${gone.status}`);
  }
});

e2eTest("头像：超限文件与非法类型被拒", async () => {
  const ts = Date.now();
  const username = `avatar_bad_${ts}`;
  const token = await registerUser(
    username,
    `${username}@test.com`,
    TEST_PASSWORD,
  );

  const textBytes = new TextEncoder().encode("not-an-image");
  const cases: [string, string, Uint8Array][] = [
    ["big.png", "image/png", new Uint8Array(2 * 1024 * 1024 + 1).fill(0x89)],
    ["a.txt", "text/plain", textBytes],
    ["a.svg", "image/svg+xml", textBytes],
    ["fake.png", "image/png", textBytes],
  ];
  for (const [name, type, data] of cases) {
    const res = await uploadAvatar(token, avatarForm(name, type, data));
    if (res.status !== 400) {
      throw new Error(`应拒绝 ${name}，实际 ${res.status} ${JSON.stringify(res.body)}`);
    }
  }

  // 被拒后头像仍未设置
  const me = await apiGet("/api/v1/auth/me", token);
  const userId = (me.body as { data: { id: string } }).data.id;
  const none = await apiGet(`/api/v1/users/${userId}/avatar`);
  if (none.status !== 404) {
    throw new Error("非法上传被拒后头像应保持未设置");
  }
});
