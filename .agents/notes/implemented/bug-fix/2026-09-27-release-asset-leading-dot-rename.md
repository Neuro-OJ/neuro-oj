# Agent Note: Release 资产名以点号开头会被 GitHub 改写成 default.<name>（install/update 全线 404）

Status: implemented

## Problem

2026-09-27 发布 `0.10.1-beta.1` 后验收发布产物时发现：**`noj-cli install` 与
`noj-cli update` 对 0.10.1-alpha.2 以来的所有 Release 都必然失败**，报错为

```text
提交部署文件失败，已回滚：下载 .env.prod.example 失败：HTTP 404
```

根因是 GitHub 对**以 `.` 开头的 Release 资产名**做服务端改写：

| 上传方式 | 上传的文件名 / 显式 name | Release 上的实际资产名 | 原名 URL |
| --- | --- | --- | --- |
| `gh release upload` | `.env.prod.example` | `default.env.prod.example` | **404** |
| `gh release upload` | `.dotfile` | `default.dotfile` | **404** |
| uploads API + `?name=` 显式指定 | `.env.prod.leadingdot` | `default.env.prod.leadingdot` | **404** |

即在临时草稿 Release 上的三次实测（草稿与临时 tag 已删除，未触发任何流水线）：改写在
**服务端**发生，`?name=` 显式传原名也无法绕过，因此"资产侧叫 `.env.prod.example`"这条
契约**根本无法成立**。

影响面（`RELEASE_FILES` 同时被当作资产名与落盘文件名，且两处调用都无条件执行）：

- `install`：`lifecycle.ts` 第 1 步无条件 `downloadReleaseFiles` → 首装直接失败；
- `update`：第 4 步无条件同步部署文件（`--files-only` 语义）→ 升级直接失败，**没有跳过开关**；
- `update --latest` 的"资产就绪"过滤（`UPDATE_RELEASE_ASSETS`）同样按原名比对，永远不命中；
- 三个 Release 受影响：`0.10.1-alpha.2`、`0.10.1-alpha.3`、`0.10.1-beta.1`
  （`v0.10.0` 与 `0.10.1-alpha.1` 压根没有资产，属另一种失败）。

既有测试为什么没拦住：单元测试全部使用**注入的假 fetcher**（URL 与资产名自洽），CI 的
`test:production` 也只跑 `src/prod/` 的离线测试；工作流侧那条测试只断言 release.yml
的 `gh release upload` 行里**写了**这些名字，而 GitHub 侧的改写不在本地可观测范围内。

## Decision

把"Release 资产名"与"安装目录里的文件名"**显式分离**：

- `.github/workflows/release.yml`：把模板复制成**非点号资产名**后再发布——
  `cp .env.prod.example env.prod.example` + `sha256sum env.prod.example > env.prod.example.sha256`，
  上传 `env.prod.example` / `env.prod.example.sha256`；并在同一步加兜底自检
  （资产名不得以 `.` 开头、文件必须存在，否则 `::error::` 失败）。
- `noj-cli/src/prod/bootstrap.ts`：`RELEASE_FILES` 由 `string[]` 改为
  `ReleaseFile[]`（`{ asset, target }`）——`asset` 用于拼
  `<repo>/releases/download/<ref>/<asset>` 与其 `.sha256`，`target` 用于落盘路径。
  模板条目为 `{ asset: "env.prod.example", target: ".env.prod.example" }`。
- `noj-cli/src/prod/release.ts`：`UPDATE_RELEASE_ASSETS` 取 `asset`（Release 侧比对）；
  `noj-cli/src/prod/lifecycle.ts` 的 `hasReleaseAssets(dir)` 取 `target`（本地文件判定）。
- 回归守卫（`bootstrap_test.ts`）：新增"资产名不得以点号开头、不得含 `/`、至少有一条
  asset≠target"，并扩展工作流测试，要求 release.yml 对 asset≠target 的条目必须出现
  `cp <target> <asset>`；`release_test.ts` / `lifecycle_test.ts` 的就绪资产集合改为
  `env.prod.example`（含 `.sha256`）。

用户可见结果不变：安装目录里仍然是 `.env.prod.example`（`seedEnvFile` 的输入、
`.env.prod` 的模板），仅 Release 侧资产名变化。

## Alternatives considered

1. **把仓库文件本身改名成 `env.prod.example`**（去掉点号）：能同样绕开改写，但要动
   文档、`.env.prod.example` 的所有引用与运维习惯（"复制模板成 .env.prod"），收益仅是
   少一层映射；且资产名与落盘名分离本来就是需要长期存在的能力（例如未来再加资产）。
2. **CLI 侧兼容两种名字（原名 404 时回退到 `default.<name>`）**：能让旧 Release 也可安装，
   但把 GitHub 的改写行为固化进 CLI，且旧 Release 仍是 alpha 质量、`--latest` 又按稳定
   标签过滤（`0.10.1-beta.1` 不匹配 `^v?\d+\.\d+\.\d+$`）本就选不中它们；引入双名回退
   会掩盖"资产名又写错"这类回归，因此不做。
3. **改用源码归档（`archive/<ref>.tar.gz`）取模板**：违背 bootstrap 的"同版本资产 +
   SHA-256 校验"契约（那正是 issue #431 的解法），且把发布体积与解析面都放大。
4. **在 CI 里真正跑一次 `install`（对真实 Release 或本地起的假 Release 服务）**：能提前
   发现，但需要网络与容器，属于 e2e 范畴；本次先用"资产名约束 + 工作流自检"的静态门禁
   覆盖，真实安装链路已在 0.10.1-beta.2 发布后手工实测（`downloadReleaseFiles` 成功、
   资产 URL 200）。

## Consequences

- `install` / `update` 自 `0.10.1-beta.2` 起恢复可用；**`0.10.1-alpha.2` ~ `0.10.1-beta.1`
  的 Release 无法用 CLI 安装或升级**（含 `docker-compose.prod.yml` 的 MinIO 修复）。
  受影响实例只能手工同步 compose 文件，或直接升级到 beta.2 及以后。
- Release 资产契约增加一条硬约束：**资产名不得以 `.` 开头**。发布前自检 + 两条测试
  （资产名形状、工作流 `cp`）共同保证它不会静默回流。
- `RELEASE_FILES` 的类型从字符串数组变为对象数组（`noj-cli/src/mod.ts` 转导出同名符号），
  是 noj-cli 公共 API 的一次小破坏性变更；仓库内唯一消费者已同步。
- `release.yml` 的资产准备步骤现在会多产出 `env.prod.example`（构建产物文件，不写回仓库）。
