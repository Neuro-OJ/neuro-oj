# Agent Note: 模块版本号一致性门禁

Status: implemented

## Problem

Issue #658
记录的三处版本漂移，根因相同：**版本号在多处独立声明，且没有任何检查会因此失败**。

- 7 个模块各自在清单里声明 `version`（`noj-core` / `noj-llm-gateway` / `noj-cli`
  / `noj-tests` 的 `deno.json`，`noj-ui` / `noj-lmcc-extension` 的
  `package.json`，`noj-judge` 的 `Cargo.toml`）。实测 `noj-tests` 停在
  `0.9.5`，其余 6 个是 `0.10.5`，没有任何门禁发现。
- `SECURITY.md` 的支持版本表仍写 `v0.9.x`（当前正式版 `v0.9.5`），而最新正式
  Release 已是 `v0.10.6`。安全报告的适用范围因此误导报告者。
- `README.md`、`noj-cli/README.md`、`noj-docs/docs/operators/{judge-workers,production-deploy}.md`
  的安装/下载示例仍指向 `v0.10.4-rc.1`（一处为
  `v0.10.5`）。照文档复制命令会装到旧版本，且与「二进制与 `--ref`
  必须一致」的说明互相打架。

三处都是「写死的副本没有单一事实源」：文档与清单各自演进，人只能靠记忆同步。

## Decision

- `noj-tests/deno.json` 对齐到 `0.10.5`，与其余 6 个模块一致。**不**统一提升到
  `0.10.6`：模块版本（源码内声明的
  SemVer）与发布标签（`v0.10.6`）是两套语义，把两者绑死会让每次发版都必须改 7
  个文件，反而制造新的漂移与噪音。
- 新增 `scripts/check-version-consistency.ts`：从 `VERSION_MANIFESTS`（7
  条清单的单一事实源）读取并解析版本，断言完全一致；不一致时打印每条清单的实际版本与基准版本，以非零码退出。解析与比较拆成可测试的纯函数（`parseJsonManifestVersion`
  / `parseTomlManifestVersion` /
  `compareVersions`），并带零输入守卫（扫不到清单即失败，而不是「无漂移」）。
- 门禁登记进 `scripts/gate-list.ts` 的 `REPO_GATES`（`check-ci.ts` 与
  `check-all.ts` 都从该清单派生），自测
  `scripts/check-version-consistency_test.ts` 登记进 `GATE_SELF_TESTS`。
- `SECURITY.md` 支持版本表改为 `v0.10.x`（当前正式版 `v0.10.6`），保留「以
  GitHub Releases 最新正式版本为准」。
- 文档里明确写了旧 tag 的安装/下载示例改为 `v0.10.6`；`VERSION=x.y.z`
  这类占位符保持占位，不硬编码具体版本。

## Alternatives considered

- **把版本号提升到 `0.10.6`，与 Release
  标签对齐**：看起来「更一致」，但会让模块版本号变成发布标签的镜像，每次发版（含仅改文档的补丁）都要改
  7 个清单；且预发布阶段（`-rc.N`）无法表达。维护者选择保持两套语义分离。
- **只改文档、不加门禁**：本次三处漂移就是「只改文档」的历史结果，同类问题在
  2026-10-05 的文档准确性修订后不到两周再次出现，因此必须让漂移可失败。
- **让门禁直接校验「等于最新 Release」**：需要联网调 GitHub
  API，门禁变成依赖外网的脆弱检查，且会把「模块版本 vs 发布标签」再次混为一谈。
- **用 `deno task` 或 workspace 统一版本**：`noj-judge` 是 Cargo 工程，`noj-ui`
  是 npm 工程，Deno workspace 覆盖不到，仍需跨生态读取，收益不足以抵消改造范围。

## Consequences

- 任何模块清单版本漂移都会让 CI 的 root-gates 与本地
  `deno run -A scripts/check-all.ts`
  直接红灯，并指出是哪几个文件、各自是什么值。
- 发版流程多一步显式决策：要么 7
  个模块一起升版本，要么都不动——门禁不会替人决定升到哪个值。
- 文档中的具体版本示例仍会随发版过期，本门禁**不覆盖**文档；这类漂移仍需人工在发版时检查（`SECURITY.md`
  的支持版本表同理）。
- `noj-tests` 版本号变更不影响其 `exports: {}` 与 E2E 任务，无运行时行为变化。
