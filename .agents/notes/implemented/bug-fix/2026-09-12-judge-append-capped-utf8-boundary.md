# Agent Note: 修复 judge 输出截断在多字节字符边界 panic

Status: implemented

## Problem

`noj-judge/src/dual/mod.rs` 的 `append_capped` 用 `buf[start..]` 截断，`start` 由字节长度相减得到，可能落在多字节字符内部——**中文评测输出累计超过 1 MiB（`MAX_OUTPUT_BYTES`）是常态**。panic 发生在 `tokio::spawn` 的任务内，`JoinHandle` 的 Err 只被 `error!` 记录（`main.rs`），于是结果永不推送、任务永不 ACK，提交永久停在 `judging`；core sweeper 重投后再次 panic，形成无限循环。用 `rustc` 单独复刻旧实现可稳定复现（1800 字节中文块 ×1000 轮，第 583 轮 `byte index ... is not a char boundary`）。

## Decision

截断点一律对齐到字符边界（`ceil_char_boundary`，向上取整以保证 `MAX_OUTPUT_BYTES` 成为**硬上限**），单次追加本身超限时只保留其尾部。补 4 条单测：多字节边界回归（1000 轮）、保留尾部且不超上限、单次超大追加、小块累积。

## Alternatives considered

- 向下取整（保留更多字节）：会让总长度略微超过上限，硬上限语义被破坏。
- 改用 `Vec<u8>` 累积、输出时 lossy 转换：更彻底但改动面大，且现有 9 个调用点都依赖 `String`。
- 只加 `is_char_boundary` 断言：panic 变成更早的 panic，不解决问题。

## Consequences

中文评测不再丢结果；输出长度有硬上限。`dual/mod.rs` 行数增至 2246，已登记进 `scripts/check-file-size.ts` 棘轮基线（禁止继续变大）。
