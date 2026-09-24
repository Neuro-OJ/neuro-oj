# Agent Note: tests/ 顶层测试文件在两条测试路径中从未被执行

Status: implemented

## Problem

`noj-core` 有几条并行的测试路径，其中两条以**目录**为单位枚举测试目标，而不是
交给 Deno 自己发现：

| 路径 | 入口 | 枚举方式 |
| --- | --- | --- |
| `test:shared`（CI `core-shared` job） | `scripts/test-shared.sh` | 显式列出 `tests/shared`、`tests/routes`、`tests/db` 等**目录**，顶层文件只列了 `app.test.ts`、`smoke.test.ts` |
| `test:parallel`（CI `core-test-sharded` job） | `scripts/test-parallel.ts` | 每个 shard 的 `dirs` 数组显式列出目录与个别文件 |
| `deno task test`（本地全量） | `scripts/test-all.sh` | `deno test` **不带路径**，由 Deno 自行发现全树 |

`deno test tests/routes` 这类目录参数**不会**带上 `tests/*.test.ts`。因此散落在
`tests/` 顶层的三个文件此前只在「无路径」的全量路径下运行，而在两条 CI 路径中
完全缺席：

| 文件 | 用例数 | `test-shared` | `test-parallel` |
| --- | --- | --- | --- |
| `tests/security-headers.test.ts` | 1 | 否 | 否 |
| `tests/types_safety_test.ts` | 2 | 否 | 否 |
| `tests/defensive-patterns_test.ts` | 2 | 否 | 否 |

取证：三个文件共 5 个用例全部通过（`ok | 5 passed | 0 failed`），说明它们是有效
测试，只是在这两条路径下从未被触发。

覆盖该盲区的门禁 `scripts/check-test-discovery.ts` 只检查**文件名约定**是否会被
Deno 发现（`_test.ts` / `.test.ts`），这三个文件命名合规，因此门禁输出
「测试文件可发现性检查通过」：命名可发现 ≠ 被某条测试脚本实际纳入。

需要澄清的一点（避免重复我最初的过度判断）：本缺陷**不是**"这些测试从未在任何
地方执行"。`deno task test` 不带路径、走全树发现，确实会运行它们（实测日志可见
`running 1 test from ./tests/security-headers.test.ts`）。缺陷范围是**两条 CI
路径**——PR 上真正跑的是 `test-shared.sh` 与 `test-parallel.ts`，全量路径只在本地
或覆盖率流程中用到。也就是说：这三个文件的回归保护在 CI 上是缺失的。

## Decision

在 `scripts/test-shared.sh` 的共享测试批次中显式列出这三个文件，并加注释说明
目录枚举为何会漏掉顶层文件。选 `test-shared.sh` 而非 `test-parallel.ts`，是因为
这三个文件都不依赖 DB/Redis（`security-headers` 只用 `createApp()`，
`types_safety` / `defensive-patterns` 是纯函数断言），放进无 schema 要求的共享
批次最简单、也最贴近它们本来的归属。

## Alternatives considered

- **同时改 `test-parallel.ts`**：需要判断每个文件该进 `unit` 还是 `db` shard，
  而 shard 各自绑定独立 schema/Redis DB，改动面与风险都更大；`test-shared.sh`
  已覆盖 CI 门禁需求，先做这一处。
- **改成 `deno test tests/*.test.ts` 通配**：会把 `tests/helper.ts`、
  `tests/preload.ts`、`tests/_setup.ts` 等辅助模块一并喂给运行器。实测这些文件
  返回 `ok | 0 passed | 0 failed` 且退出码 0，不会失败，但让命令含义变模糊，且新增
  辅助模块时容易误列。显式列出更可控。
- **让 `check-test-discovery.ts` 增加"文件是否被某测试脚本引用"的检查**：这是更
  根本的方向，但需解析各脚本的 `deno test` 参数并处理 glob/变量，容易误报
  （`test-all.sh` 走全树发现，会天然覆盖而无需列举）。留作后续独立改进。
- **删除这三个文件**：5 个用例断言的是安全头、类型安全、防御性模式等有价值行为，
  删除会丢失真实覆盖。

## Consequences

`bash scripts/test-shared.sh` 现在执行这三个文件（日志可见
`running 1 test from ./tests/security-headers.test.ts` 等），套件输出由
`ok | 238 passed | 0 failed | 7 ignored` 变为
`ok | 243 passed | 0 failed | 7 ignored`，新增 5 个用例全部通过。

`deno task test` 全量路径行为不变，仍为
`ok | 1325 passed | 0 failed | 58 ignored`。

`test-parallel.ts` 的 shard 划分本轮未改，这三个文件在该路径下仍不执行——
若后续希望两条路径完全对齐，可在 `unit` shard 的 `dirs` 中补上。
