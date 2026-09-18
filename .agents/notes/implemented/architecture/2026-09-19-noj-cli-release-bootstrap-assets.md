# Agent Note: noj-cli 从 Release 自举生产部署文件

Status: implemented

## Problem

纯 TS 重写（spec §3.3 洞 2）要求移除 `setup.sh` 与 `scripts/deploy/install.sh`，
用户改为手动下载 `noj-cli` 二进制。但 `install` 仍需 `docker-compose.prod.yml`
与 `.env.prod.example`——旧 `install.sh` 从源码归档
（`$REPO/archive/$REF.tar.gz`）解压后 `cp`（`install.sh:608-673`）。
删掉 `install.sh` 后，若 CLI 仍依赖源码归档，则"手动下载单个二进制即可安装"
的目标不成立，形成自举死锁。

同时存在一个只有在真实 Release 上才会暴露的硬前置：
`.github/workflows/release.yml` 原先只发布
`noj-cli-linux-amd64` 与 `noj-cli-linux-amd64.sha256` 两个资产。
即便 CLI 实现了下载逻辑，若不扩展发布资产，生产环境中
`docker-compose.prod.yml` / `.env.prod.example` 无资产可下；而单元测试使用
注入的 fetcher，不会触网、也不会发现这一缺口。

## Decision

新增 `noj-cli/src/prod/bootstrap.ts`，把"下载并校验部署文件"的职责吸收进 CLI：

- `downloadReleaseFiles({ repository, ref, targetDir, overwrite?, fetcher? })`
  从 `<repo>/releases/download/<ref>/<asset>` 下载 `RELEASE_FILES` 中的每个文件
  及其 `.sha256`，复用 `util/hash.ts` 的 `sha256Hex` 校验后才落盘。
- 使用 Deno 内置 `fetch()`（可注入），不 spawn `curl`/`wget`：去掉外部二进制
  依赖，并彻底消除拼接 shell 命令的注入面。
- 仓库地址必须 HTTPS；`ref` 沿用 `install.sh:185-190` 的字符白名单
  （`^[A-Za-z0-9._/-]+$`、非前导/尾部 `/`、不含 `..`、不含 `//`、非空）。
- 校验文件正文取首个空白分隔字段，接受大小写十六进制，统一小写后比较
  （对照 `install.sh:551,553`）。
- **失败原子性**：先下载 + 校验**全部**文件到 `targetDir` 内的
  `.bootstrap-<uuid>.tmp` 暂存文件，全部通过后才 `rename` 进目标目录；
  任一步失败只清理暂存文件，目标目录不留半成品、也不覆盖原文件。
- **已存在目标文件默认拒绝**（`overwrite: false`）：安装目录里的
  `.env.prod` 是用户维护的配置，`docker-compose.prod.yml` 也可能被手工调整；
  静默覆盖会破坏生产配置。需要更新时由调用方（T12 `install`）显式传
  `overwrite: true`，此时暂存 + rename 保证"要么全新、要么原样"。
- 扩展 `.github/workflows/release.yml` 的 `publish-cli`：用 `sha256sum`
  生成并上传四个新资产
  `docker-compose.prod.yml`、`docker-compose.prod.yml.sha256`、
  `.env.prod.example`、`.env.prod.example.sha256`。

## Alternatives considered

- **继续下载源码归档**（保留 `archive/$REF.tar.gz` + 解压 + `cp`）：需要 `tar`、
  目录穿越防护与归档校验等一整套逻辑，且让"单二进制安装"重新依赖源码分发；
  spec R4 的目标正是彻底去掉这条路径。
- **让用户手动放置两个文件**：把复杂度推给用户，且 `install` 无法保证
  文件与 CLI 版本一致，违背"同版本资产"约束。
- **spawn `curl` / `wget`**：与 `install.sh` 一致但引入外部二进制依赖，
  参数拼接也带来注入面；Deno 的 `fetch()` 已足够且可注入测试。
- **目标文件已存在时直接覆盖**：升级 compose 时方便，但对用户维护的
  `.env.prod` 与手工调整过的文件是破坏性的；拒绝 + 显式 `overwrite`
  把决定权交回调用方与用户。
- **先写第一个文件再校验第二个**：实现更简单但会在校验失败时留下半成品，
  正是本任务要消除的失败模式。

## Consequences

- `install`（T12）可直接从 Release 取回与 CLI 同版本的部署文件，不再依赖
  `install.sh` 与源码归档；T24 删除 `install.sh` 后仍有完整路径。
- Release 资产契约变为六个文件：`noj-cli-linux-amd64`、`noj-cli-linux-amd64.sha256`、
  `docker-compose.prod.yml`、`docker-compose.prod.yml.sha256`、
  `.env.prod.example`、`.env.prod.example.sha256`。后续修改安装流程必须同步
  维护这组资产（`report` 中已声明给 T12）。
- `bootstrap_test.ts` 中一条测试直接读取 `release.yml`，断言 `gh release upload`
  段包含全部六个资产名；这正是"注入 fetcher 的单测不会发现的发布缺口"的
  回归防线。
- 默认拒绝覆盖意味着升级 compose 必须显式传 `overwrite: true`；
  调用方若省略会得到明确错误而非静默旧文件。
