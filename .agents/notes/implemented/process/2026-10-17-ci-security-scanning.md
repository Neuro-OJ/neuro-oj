# Agent Note: CI 依赖漏洞审计与静态代码扫描

Status: implemented

## Problem

CI 只在 `release.yml` 对发布镜像做 trivy 扫描，PR 阶段完全没有依赖漏洞审计与
SAST（issue #661）：

- `noj-judge/Cargo.lock`、5 个 `deno.lock`、`noj-docs` 与 `noj-lmcc-extension`
  的 `package-lock.json` 共 9 份锁文件不做漏洞比对， PR
  引入带已知漏洞的依赖不会被拦截；
- 没有 CodeQL 或等价静态扫描，注入 / XSS / 不安全反序列化等代码级缺陷
  只能靠人工评审；
- 新披露的漏洞不需要改代码就会命中存量锁文件，纯 PR 触发无法发现这类漂移。

另有一个平台限制：`dependency-review-action` 依赖 GitHub Dependency Graph，
而仓库所属组织禁用了该能力（`/dependency-graph/compare` 返回 404，当前账号
是组织 member、无 owner 权限，无法自行开启）。直接运行该 action 会让每个
PR 变红。

首次落地还必须满足一条硬约束：**不能让现有 `main` 与现有 PR 变红**。本地
基线实测存量告警规模为：`cargo audit` 32 个漏洞（quinn-proto 5、rustls 4、
wasmtime 15、wasmtime-wasi 5、zip 3），`osv-scanner` 在 5 个 deno.lock 上 73
个（31 个包，7 critical / 26 high）、在 2 个 package-lock.json 上 20 个 （11
个包，7 high）。

## Decision

新增 `.github/workflows/security.yml`，四个 job：

- **dependency-review**：仅 `pull_request`，`fail-on-severity: high`。它只
  比对 base↔head 的新增依赖，不受存量影响。权限 `contents: read` +
  `pull-requests: write`。先用 `gh api .../dependency-graph/compare/...` 探测：
  可用才运行 action；不可用则**显式跳过**并写 job summary 告警（措辞明确为
  "未执行，不代表扫描通过"），组织 owner 启用 Dependency Graph 后自动恢复。
- **cargo-audit**：`cargo install cargo-audit --locked --version 0.22.2` 后 对
  `noj-judge/Cargo.lock` 跑 `cargo audit --json`。不用
  `rustsec/audit-check`：它需要 `issues: write` + `checks: write` 才能在
  失败时建 issue/check，fork PR 上 token 只读还会降级；直接跑 CLI 保持
  `contents: read`。
- **osv-scanner**：`google/osv-scanner-action` 扫描 5 个 `deno.lock` 与 2 个
  `package-lock.json`。实测 osv-scanner 2.7.0（osv-scalibr 0.5.3）**没有
  deno.lock 提取器**，直接传会以 127 退出、等于零扫描；因此新增
  `scripts/security/deno-lock-to-package-lock.ts`，把 deno.lock v5 的 `npm`
  段转成 package-lock v3 再扫描。转换器必须补 `resolved` 字段—— 缺失时
  osv-scanner 会静默跳过该包（实测 lodash 4.17.20 不报任何漏洞）。
- **codeql**：`javascript-typescript`，`pull_request` + `push(main)` + 每周
  `schedule`。CodeQL 官方不支持 Rust，Rust 侧由 cargo-audit 承担，不硬加 语言。

触发成本：`dorny/paths-filter` 计算 `deps` / `codeql` 两组过滤，PR 与 main push
只跑相关 job；`schedule` 与 `workflow_dispatch` 全量跑。定时任务是
发现"锁文件没变但新披露了漏洞"的唯一手段。

存量处理：cargo-audit 与 osv-scanner 采用「发现漏洞 = 告警、工具或解析失败 =
失败」的告警态——扫描结果写入 `$GITHUB_STEP_SUMMARY` 并输出 `::warning`，但 job
不失败。工具退出码 >1、结果 JSON 缺失或不可解析时仍然
硬失败，避免把"扫描没跑起来"伪装成"没有漏洞"。

## Alternatives considered

- **对 32 + 73 + 20 个存量告警逐个 `--ignore` / `IgnoredVulns`**：显式且
  可审计，但一百多条豁免的维护成本高于收益，且漏洞修复后豁免不会自动清理。
- **第一天就硬失败**：会立刻让 `main` 与所有现有 PR 变红，违背落地约束。
- **`rustsec/audit-check`**：省去安装步骤，但需要 `issues: write` +
  `checks: write`，fork PR 上无法创建 check，权限面也比直接跑 CLI 大。
- **osv-scanner 官方 reusable workflow**：自带 PR 增量比对，但仍不支持
  deno.lock，且无法插入转换步骤；直接调用 action 才能控制 `--lockfile` 列表与
  JSON 汇总。
- **只加 `schedule` 不加 paths 过滤**：每个文档 PR 都要装 cargo-audit、 跑
  CodeQL，成本与收益不匹配。
- **CodeQL 加 Rust**：官方不支持，硬加只会得到一个永远不执行的 job。
- **直接删掉 dependency-review**：能避免绿但无效的 check，但组织启用
  Dependency Graph 后又要重新加回来；保留探测逻辑更省事。
- **让 dependency-review 无条件失败**：每个 PR 都会红，违背落地约束。

## Consequences

- PR 新增 high/critical 依赖会被 dependency-review 直接拦截；cargo-audit 与
  osv-scanner 目前只告警，**新引入的 Rust / deno 依赖漏洞仍不会被硬拦截** （npm
  / cargo 的增量由 dependency-review 覆盖，deno.lock 增量暂无硬门禁）。
- 收紧路径：先升级 wasmtime / zip / rustls / quinn-proto 与 noj-ui 的 vite /
  vitest / undici 等依赖清存量，再把两个 job 改为硬失败并删除 CONTRIBUTING.md
  的告警态说明；deno.lock 的 PR 增量拦截需要额外做 base↔head 结果比对。
- 转换器是 deno 覆盖的唯一入口：deno.lock 格式升级或 osv-scalibr 改变
  package-lock 解析行为时，`scripts/security/deno-lock-to-package-lock_test.ts`
  与转换器的零输入守卫会失败，不会静默变成零扫描。
- jsr 依赖不在扫描范围内（OSV 无 npm 记录）；CodeQL 不覆盖 Rust；这两块
  需要后续用其他工具补齐。
- 每周定时扫描会产生固定的 CI 开销；存量清完后可评估把 `schedule` 降频。
