# Agent Note: 生产 update/upgrade 的版本解析、备份门禁与两段式配置

Status: implemented

## Problem

`update` 是生产**唯一**的升级入口（`upgrade` 是它的别名，bash
`production.sh:518-519` 两个词进同一函数）。bash 侧它有 236 行（`production.sh`
:201-436），横跨四件事，每件都有各自的失败面：

1. **版本解析**（`latest_release_version` :255-323）：必须按 Release **列表**过滤
   （draft / prerelease / 资产就绪），**不得**用 `/releases/latest`——issue #431
   记录的正是"已发布但镜像 / CLI 资产尚未就绪"的版本被选中，install 与 upgrade
   必须用同一版本集合。bash 用 `awk` 在 JSON 文本上做正则匹配，过滤规则与
   `install.sh` 的 `resolve_latest_ref` 各写一份。
2. **版本配置落盘**（`write_config_version` :324-344）：只改 `NOJ_VERSION`，
   保留注释 / 其它键 / 顺序，原子写。`NOJ_VERSION` 直接参与
   `docker-compose.prod.yml` 的镜像 tag 插值，因此**不能**改写 `v` 前缀。
3. **升级序列的门禁**（`deploy.sh:1034-1044`）：`prepare_and_check` →
   `ensure_backup_passphrase` → **备份** → `compose pull` → `wait_for_stack` →
   `record_deployment_metadata`。`test-deploy.sh:487-494` 有一条专门的用例：
   **备份失败后仍执行了镜像拉取或启动即判失败**——备份是"不可省、且必须最早"的一步。
4. **两段式配置提交**（`update --latest` :400-436）：先把目标版本写进**暂存**
   文件，同步文件 → 升级 → **成功后才** `mv` 覆盖 `.env.prod`。失败时删暂存、
   保持原配置不变，避免"服务没升上去但配置已指向新版本"。

## Decision

新增 `noj-cli/src/prod/release.ts` 承载版本解析与配置落盘，`prod/lifecycle.ts`
新增 `update()` / `upgrade()` 承载编排，并把两条**跨命令共享**的步骤抽到
`prod/lifecycle/steps.ts`：

1. **过滤规则抽为共享纯函数，资产集合由调用方给出**（任务书给的两个选项之外的
   第三种，见下「Alternatives considered」）。`runtime/download.ts` 导出
   `isStableReleaseTag(tag)` 与 `selectLatestAssetReadyRelease(releases, assets)`；
   `resolveLatestVersion()` 保持原语义（CLI 资产），T16 的
   `resolveLatestReleaseTag()` 传更宽的 `UPDATE_RELEASE_ASSETS`
   （compose / example 由 T9 的 `RELEASE_FILES` 派生，不手抄第二份清单）。
   理由是 `update` 会以目标 ref 重新拉取部署文件，该 ref 缺文件**必然**失败，
   因此升级必须要求它实际会用到的全部资产都就绪。
2. **版本比较归一化 `v` 前缀，写入时保留原文**。bash 用
   `[[ "$version" == "$current" ]]` 逐字比较；实测仓库里 `0.1.0-rc.2` 与
   `v0.9.5` 两类 tag 并存，`.env.prod` 里写 `0.9.5`（合法，`install` 的默认值
   就是 bootstrap 传的 `REF`）而最新 Release 是 `v0.9.5` 时，`--latest` 会认为
   "有新版"，从而白跑一次备份 + 拉镜像 + 重启全部服务。`normalizedVersion()`
   只用于**比较**；写入配置仍用原始 tag（它直接参与镜像 tag 插值）。
3. **暂存与提交分离**（`stageConfigVersion` / `commitConfigVersion`）。暂存文件
   放在 `.env.prod` **同目录**：跨目录 `rename` 可能退化为拷贝并丢失原子性
   （bash 的 `mktemp "${env_file}.latest.XXXXXX"` 亦然）。提交失败时**保留**
   暂存文件并单独报"服务已升级但配置未提交"的半完成态——那是用户配置的唯一
   新副本，删掉会丢信息。
4. **`ensureCommandPassphrase`**（`steps.ts`）：把 `deploy.sh:920-953` 的**命令级
   装配**收敛为一处。install 第 4 步此前内联实现，update 的升级序列需要逐字同一套
   语义（路径四级优先 / 回填门**只**读进程环境 / 新生成口令告警 / 回填后重新读取），
   各写一遍必然漂移。失败以 `error` 返回而非抛错，因为 install 抛错、update 转
   退出码 1，两者风格不同。
5. **`composePull`** 落进 `prod/compose.ts`（T12/T13 登记的 carry-forward），
   顺带补上 `composeConfig` 缺失的 `--quiet`：bash 的前置校验跑的是
   `run_compose config --quiet`（`deploy.sh:904`），T10 封装漏了该旗标。
   此前未暴露是因为只断言了退出码；T16 断言参数形状时暴露出来。缺省
   `quiet:false` 保留 T10 的通用语义（渲染结果在 stdout），`prepareAndCheck`
   的步骤 6 显式传 `quiet:true`。
6. **备份子系统的接口先立住**。bash 的 `run_backup "upgrade"` 调
   `backup.sh create`；TS 侧的生产备份（`.nojbackup` 单文件容器）归 T17–T19。
   本任务**不实现**它，但**也不静默跳过**：备份经注入点
   `UpdateOptions.backup` 调用，未注入即返回明确失败（退出码 1，且尚未 pull/up）。
   这样升级序列与它的顺序断言在 T17–T19 接上真实实现时都不用改。

## Alternatives considered

- **扩展 `resolveLatestVersion` 的资产集合**（任务书的选项一）：会让 `init` 向导
  也要求 compose / example 资产就绪——那是**安装**不需要的条件（`install` 本来
  就要下载它们，但 `init` 只是选版本号），且会改变既有 5 个用例的语义。
- **在 `prod/` 内另写一份等价过滤**（任务书的选项二）：筛选规则（稳定标签 →
  非 draft → 非 prerelease → 资产齐备）会存在两份实现，正是 issue #431 那类
  "install 与 update 版本集合不一致"缺陷的温床。
- **沿用 bash 的逐字版本比较**：会在 `0.9.5` vs `v0.9.5` 时误判为有新版本，
  代价是一次完整的备份 + 拉镜像 + 重启。归一化比较是**有意的**偏离，已写进
  `normalizedVersion` 的 JSDoc。
- **让 `update` 在备份未接线时成功返回并告警**：这会让 `update` 在 T17–T19 之前
  静默地"升级而不备份"，与 `test-deploy.sh` 的备份门禁用例直接冲突（该用例断言
  备份失败后**不得** pull/up）。明确失败比静默降级正确。
- **`upgrade` 复制一份编排只去掉 `--latest` 分支**：别名若有第二份实现，迟早漂移
  （bash 正是靠 `update|upgrade)` 共用一个函数避免这点）。`upgrade()` 只是
  `update({ ...opts, latest: false })` 的转发，并有测试断言两者结果逐字一致。
- **把 `--dry-run` 一并迁移**：bash 的 `update` 有 `sync_dry_run` 分支；T13–T15
  已连续登记"不迁移 `--dry-run`"，本任务保持一致（T16 brief 亦未要求）。

## Consequences

- **`--latest` 的 no-op 保证零副作用**：最新版本与当前相等时，测试断言事件序列
  **完全为空**（零 compose、零备份、零文件同步），且 `.env.prod` 逐字节不变。
- **备份严格早于任何 compose 变更**：备份失败 → 零 pull、零 up；未接线备份 →
  同样失败。两条都有显式断言。
- **升级失败不污染配置**：失败路径丢弃暂存文件、`.env.prod` 逐字节不变；
  提交失败单独报半完成态并保留暂存文件。
- **21 个 update/upgrade 用例 + 19 个 release 用例**，全部注入
  （Release 元数据走 fetcher、docker 走 runner、备份与文件同步走回调），
  不触网、不起容器、不改真实配置。
- **`composeConfig` 的参数形状变了**（前置校验现在多一个 `--quiet`）：
  既有 install/start/status 的断言相应更新，`compose_test.ts` 新增
  `quiet=true` 与 `composePull` 两个用例。
- **CLI 入口仍未接线**（与 T12–T15 同一状态）：`cli.ts` 仍把 `update`/`upgrade`
  路由到 `runProduction` → bash。本次交付的是可注入的纯 TS 命令实现，接线按
  任务书归 T24（删除 bash 之前必须完成）。
- **`--files-only` 的"保留 `.env.prod`"是结构保证而非额外逻辑**：T9 的
  `RELEASE_FILES` 只含 compose / example 及其校验文件，`.env.prod` 不在其中，
  因此 `overwrite:true` 也不可能碰到配置。测试对这一点有逐字节断言。
- **`releasesApiUrl` 比 bash 多剥一个 `.git` 后缀**：bash 的正则
  `[^/]+/[^/]+` 会把 `…/neuro-oj.git` 当合法仓库名，拼出必然 404 的地址；
  安装侧 `install.sh` 本来就剥 `.git`，这里与安装侧对齐。
