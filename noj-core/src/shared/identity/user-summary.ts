/** 面向展示的用户摘要，不包含邮箱、角色或对象存储地址。 */
export interface UserSummary {
  id: string;
  username: string;
  avatar_url: string | null;
  state: "active" | "deleted";
}

/** 将经业务查询授权的用户字段投影为统一身份；注销账号隐藏姓名及头像。 */
export function publicUserSummary(user: {
  id: string;
  username: string;
  avatar_url?: string | null;
  deleted_at?: string | null;
}): UserSummary {
  if (user.deleted_at) {
    return {
      id: user.id,
      username: "已注销用户",
      avatar_url: null,
      state: "deleted",
    };
  }
  let avatar: string | null = null;
  if (user.avatar_url) {
    avatar = `/api/v1/users/${encodeURIComponent(user.id)}/avatar`;
    try {
      const version = new URL(user.avatar_url, "https://noj.invalid")
        .searchParams.get("checksum_sha256");
      if (version && /^[a-zA-Z0-9_-]{1,128}$/.test(version)) {
        avatar += `?v=${encodeURIComponent(version)}`;
      }
    } catch { /* 存储地址不对外暴露，脏元数据由图片端点统一降级。 */ }
  }
  return {
    id: user.id,
    username: user.username,
    avatar_url: avatar,
    state: "active",
  };
}
