## MODIFIED Requirements

### Requirement: users 表

`users` 表 SHALL 新增可空列 `avatar_url`（text）：

- `avatar_url` 存储用户头像的 `noj-storage://` URL（`local` 或 `s3` 模式），未设置时为 NULL
- 迁移为纯追加（`ALTER TABLE "users" ADD COLUMN "avatar_url" text`），无破坏性变更
- 删除头像时将本列置 NULL 并清理存储文件
