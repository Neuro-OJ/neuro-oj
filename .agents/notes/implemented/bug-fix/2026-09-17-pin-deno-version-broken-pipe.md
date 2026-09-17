# Agent Note: 固定 CI 的 Deno 版本（2.9.7 的 BrokenPipe 回归）

Status: implemented

## Problem

2026-09-17 起，多个 PR 的 UI Components 门禁出现**间歇性**失败，特征高度一致：

```text
Test Files  7 passed (7)
      Tests  36 passed (36)
error: Uncaught BrokenPipe: Broken pipe (os error 32)
##[error]Process completed with exit code 1.
```

**测试全部通过，失败发生在 vitest 输出收尾阶段**。重跑即过，因此最初被误判为
「runner 侧偶发抖动」，并在 PR 评论中如此记录。

### 真正的根因（已实测定位）

`denoland/setup-deno@v2` 在仓库中以 `deno-version: v2.x`（**浮动版本**）声明了 26 处，
只有 2 处固定为 `v2.9.5`。Deno **v2.9.7 于 2026-09-17 09:04 UTC 发布**，
恰好落在「绿灯的旧运行」与「红灯的新运行」之间：

| Deno 版本 | `vitest run` 失败次数 |
| --- | --- |
| 2.9.5 | **0 / 6** |
| 2.9.6 | **0 / 6** |
| 2.9.7 | **4 / 6**（更早一次采样为 7/8） |

复现方式（无需 CI）：下载对应版本的 Deno，在 `noj-ui/` 下反复执行
`deno run -A npm:vitest run`，观察退出码与 `BrokenPipe` 字样。
2.9.7 上失败时依然打印 `Tests 36 passed`——这正是「测试绿但门禁红」的来源。

## Decision

引入 **`.dvmrc`** 作为 Deno 版本的**唯一事实源**，并要求：

1. 全部 28 处 CI 声明改用 `deno-version-file: .dvmrc`，**禁止**再写死
   `deno-version: <值>`；
2. `noj-core/Dockerfile*` 的 `FROM denoland/deno:*` 与 `.dvmrc` 主次版本一致。

`.dvmrc` 的值取 **`v2.9.5`**，理由：**沿用仓库已经做出的选择**。
`ci.yml` 的 Production CLI job 与 `release.yml` 早已 pin `v2.9.5`，
说明维护者此前已把 2.9.5 作为已知良好版本。（实测 2.9.5 与 2.9.6 均稳定，
2.9.7 才是回归版本。）

**为什么不是「只把 v2.x 改成 v2.9.5」**：那会留下 28 份重复字面量，
下次升级仍需改 28 处、且随时可能再次出现「部分固定、部分浮动」的漂移。
改为单一事实源后，升级只需改 `.dvmrc` 一行。

### 防漂移门禁

`scripts/check-deno-version.ts` 已接入 `scripts/check-ci.ts`（Root Gates），
强制上述两条约束；配套 `scripts/check-deno-version_test.ts`（7 例，含真实仓库自检）。

该门禁在实现过程中**实际抓出** `noj-core/Dockerfile.e2e` 仍停留在
`alpine-2.8.0` 的真实漂移，已一并修正为 `alpine-2.9.5`。

## Alternatives considered

- **接受间歇失败、靠重跑绕过**：门禁的价值在于「红灯即可信」。
  一个约 60-70% 概率误报的门禁会训练审查者忽略红灯，比没有门禁更糟。
- **只把 v2.x 改成 v2.9.5（不引入 .dvmrc）**：修了「固定/浮动不一致」，
  但没消除 28 份复制粘贴本身，迟早再次漂移——本 PR 的初版即如此，
  经评审指出后升级为单一事实源。
- **升级到更新的 Deno（2.9.8+）**：未验证是否已修复；在无人值守条件下，
  选择「已知良好」比「可能更好」风险更低。
- **改 vitest 配置绕过**：未能定位可靠规避方式，且会把真实的上游回归
  掩盖成配置问题。

## Consequences

- UI Components 门禁恢复确定性：不再出现「测试全绿但 job 失败」。
- CI 使用的 Deno 版本**可复现**：同一 commit 在不同时间跑出的结果一致。
- 升级路径明确：改 `.dvmrc` 一行，门禁会强制 CI 与 Dockerfile 同步。
- **代价：精确 pin 后不再自动跟进 Deno 的补丁发布。**
  缓解属于**人工流程**——`.github/dependabot.yml` 只覆盖
  `github-actions` / `npm` / `cargo` / `pip` 四个 ecosystem，**不覆盖 Deno 版本**；
  且 `github-actions` ecosystem 只更新 `uses:` 的 action 引用，
  不会修改 action 的 `with:` 入参。因此**必须人工定期核对 Deno release**，
  并按本 note 的复现方法验证后再提升 `.dvmrc`。
- 已知的其他 Deno 版本来源：`noj-core/Dockerfile` 与 `Dockerfile.e2e` 的镜像标签
  （现由门禁与 `.dvmrc` 主次版本对齐）。`.dvmrc` 是 **CI 与镜像的**唯一事实源，
  不覆盖开发者本机安装的 Deno 版本。
