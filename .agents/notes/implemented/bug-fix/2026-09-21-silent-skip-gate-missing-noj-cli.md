# Agent Note: 静默跳过与测试可发现性门禁遗漏 noj-cli 模块

Status: implemented

## Problem

仓库有两条防「假绿」的仓库级门禁，它们的**扫描根**都只列了五个模块
（`noj-core` / `noj-ui` / `noj-llm-gateway` / `noj-tests` / `noj-judge`），
**遗漏了 `noj-cli`**：

| 门禁 | 文件 | 遗漏后果 |
| --- | --- | --- |
| 静默跳过扫描 | `scripts/silent-skip-report.ts` | noj-cli 新增 `ignore` / 环境守卫不被计数，`--check` 永远通过 |
| 测试可发现性 | `scripts/check-test-discovery.ts` | noj-cli 里「写了 `Deno.test` 但文件名不被运行器发现」永远抓不到 |

`noj-cli` 是纯 TS 重写后的**正式一等模块**：44 个测试文件，且
`src/prod/e2e/roundtrip_test.ts` 有 4 处 `ignore: !isE2E`——正是静默跳过门禁
存在的理由。遗漏它是随着模块新增而产生的，不是有意豁免。

### 修复前失败的真实证据

**静默跳过**：往 `noj-cli/src/util/fs_test.ts` 追加一条 `ignore: true` 后：

```text
$ deno run -A scripts/silent-skip-report.ts --check
静默跳过清单已写入 ...（扫描 322 个测试文件，命中 509 处：...）
静默跳过门禁通过（509 处，未超过基线 516 处）
exit(before) = 0
```

即新增的 `ignore` **完全不被发现**（既不计数、也不报错）。

**测试可发现性**：在 `noj-cli/src/util/` 放入 `probe_undiscovered.ts`
（含顶层 `Deno.test`、命名不可发现）：

```text
$ deno run -A /tmp/opencode/check-test-discovery-orig.ts   # 修复前脚本
测试文件可发现性检查通过
exit(before) = 0
```

## Decision

1. 把 `noj-cli` 加入两条门禁的扫描根。
2. `silent-skip-report.ts` 抽出**单一事实源** `SCAN_ROOTS`，供 `collectHits`
   与入口处「扫描到 0 个文件即失败」的自检共用——此前两个清单分散在两处，
   `noj-cli` 正是只漏在 `collectHits` 一处的同类风险。导出 `SCAN_ROOTS`
   使「覆盖全部一等模块」可被单元测试断言。
3. `check-test-discovery.ts` 的 `checkTestDiscovery` 扫描根补上 `noj-cli`。
4. 用 `--update-baseline` 把基线从 516 更新到 513 处的**真实新口径**
   （ignore 163→160；差异来自此前报告文件与扫描输出本就不同步，见下）。
   `test-silent-skips.md` 与 `.baseline.json` 同步重新生成。
5. 新增回归：
   - `SCAN_ROOTS` 必须包含 `noj-cli` 与全部六个一等模块（防再遗漏）；
   - noj-cli 路径下 `ignore` 端到端可被扫描；
   - `checkTestDiscovery` 对 noj-cli 夹具中的不可发现测试必须报出。

## Alternatives considered

- **只补 `collectHits` 的数组、不抽 `SCAN_ROOTS`**：两处清单（collectHits 与
  自检）继续各自维护，下个模块仍可能只补一处。抽出单一事实源并用测试锁定。
- **把扫描根改成「枚举仓库顶层目录」动态发现**：会把 docs / scripts / fixtures
  等非测试模块一并扫入，且新增目录时行为不可预测；显式清单 + 测试断言更可控。
- **只修静默跳过、不修可发现性**：两条门禁同源遗漏，只修一条会留下同类盲区。
- **不更新基线、只让新命中被门禁报错**：会把「no-cli 之前从未被计入」的历史
  存量当成新增回归，`--check` 直接失败。基线必须反映新口径。
- **顺手修复 `test-silent-skips.md` 与 `.baseline.json` 的既存不同步**（report
  是 516、baseline 是 516 但扫描实际 509）：属另一条独立问题（报告/基线陈旧），
  本次以新口径重新生成，并在下方记录该观察，避免把它当本修复的一部分混淆。

## Consequences

- `noj-cli` 新增任何静默跳过都会被 `--check` 发现（数量/原因/文件三个维度）。
- noj-cli 中不可发现的测试文件会在 CI 静态门禁失败。
- 基线 total 从名义 516 变为真实 513（ignore 维度 −3）；这是**口径修正**，
  不是新增豁免。
- 遗留观察（未在本修复中处理，需人工裁决）：`dev-docs/engineering/test-silent-skips.md`
  是**生成产物但被提交**，而 `--check` 会在失败前先覆写它，导致「门禁失败却留下
  文件改动」的副作用。是否让 `--check` 在只读模式下不写文件，另开议题。
