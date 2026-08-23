## MODIFIED Requirements

### Requirement: 种子脚本可初始化管理员

系统 SHALL 在 `deno task init:system` 执行时执行 `ensureRootUser()`，并在 `deno task bootstrap:admin` / `deno task dev-setup` 执行时执行 `ensureBootstrapAdmin()`。`ensureBootstrapAdmin()` 在不存在"可登录 admin"（`user_roles` 关联角色的权限集中含 `admin:full_access` 的用户，且 `users.id != '0'`）时自动创建一个临时管理员账号（`username='admin'`, `email='admin@noj.local'`, 24 字符 base64url 随机密码），并设置 `must_change_password=true`，终端以醒目格式打印临时凭证。

管理员创建后 SHALL 将其关联到拥有 `admin:full_access` 权限的角色（如预置的 "admin" 角色）。

开发编排工具 SHALL 在 `devtool.sh start core`（包括完整 `devtool.sh start`）启动后端前执行管理员引导。该引导 MUST 复用 `.env` 中的 `ADMIN_EMAIL` / `ADMIN_PASS`：账号不存在时创建并赋予管理员权限，已存在可登录管理员时不得覆盖其密码；引导失败时不得启动后端进程。

#### Scenario: 全新部署自动创建引导管理员

- **WHEN** `deno task dev-setup`（或 `deno task bootstrap:admin`）在全新数据库上执行，且不存在可登录 admin（通过 `user_roles` + `admin:full_access` 权限判断）
- **THEN** 系统创建 username=`admin` 的临时管理员，`must_change_password=true`，并将其关联到 admin 角色，在终端打印临时凭证（含强制改密提醒）

#### Scenario: 已存在可登录 admin 时跳过

- **WHEN** `deno task dev-setup`（或 `deno task bootstrap:admin`）执行时已存在拥有 `admin:full_access` 权限的用户
- **THEN** 系统跳过引导管理员创建，不打印临时凭证

#### Scenario: 开发编排启动时创建配置管理员

- **WHEN** 开发者执行 `devtool.sh start core`，数据库中不存在 `.env` 的 `ADMIN_EMAIL` 对应账号
- **THEN** 工具在启动后端前以 `ADMIN_PASS` 创建该账号并赋予管理员权限，且开发模式下不强制首次改密

#### Scenario: 开发编排不覆盖既有管理员密码

- **WHEN** 开发者执行 `devtool.sh start core`，且数据库中已有具备管理员权限的 `ADMIN_EMAIL` 对应账号
- **THEN** 工具继续启动后端且不修改该账号的密码
