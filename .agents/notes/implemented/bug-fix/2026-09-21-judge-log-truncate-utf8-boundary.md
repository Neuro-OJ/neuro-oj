# Agent Note: judge 日志截断在多字节边界 panic（mq.rs 漏改同源缺陷）

Status: implemented

## Problem

`noj-judge/src/mq.rs` 的 `truncate_for_log` 用字节下标切分字符串：

```rust
fn truncate_for_log(raw: &str) -> String {
    if raw.len() <= 1024 {
        raw.to_string()
    } else {
        format!("{}...(truncated {} bytes)", &raw[..1024], raw.len())
    }
}
```

当第 1024 字节落在多字节 UTF-8 字符内部时，`&raw[..1024]` 会 panic
（`end byte index 1024 is not a char boundary; it is inside '错'`）。

这与 2026-09-12 已修复的 `dual/mod.rs` 的 `append_capped` 是**同源缺陷**
（见 `.agents/notes/implemented/bug-fix/2026-09-12-judge-append-capped-utf8-boundary.md`），
但当时只修了输出累积路径，**日志截断路径被漏掉**。

它的两个调用点都在**错误诊断路径**上：

| 调用点 | 触发条件 |
| --- | --- |
| `handle_pulled_message` | 队列里出现反序列化失败的坏消息（需记录原文诊断） |
| fallback 文件重放 | `~/.noj-judge` 下 fallback 结果文件反序列化失败 |

即：当系统**已经在出错**、最需要诊断信息时，记录诊断本身把进程打崩——反而丢掉
全部诊断。消息内容包含中文（题面/错误信息）是常态，因此 1024 字节边界命中多字节
字符的概率很高。

### 修复前失败的真实证据

用 `rustc` 单独复刻旧实现：

```text
$ rustc -O utf8_repro.rs -o utf8_repro && ./utf8_repro
len=1224

thread 'main' panicked at utf8_repro.rs:6:50:
end byte index 1024 is not a char boundary; it is inside '错' (bytes 1023..1026 of string)
```

在真实模块上，把新回归测试加入 `src/mq.rs` 并**暂时还原旧实现**：

```text
$ cargo test --bin noj-judge truncate
thread 'mq::tests::truncate_for_log_multibyte_boundary_does_not_panic' panicked at src/mq.rs:122:50:
end byte index 1024 is not a char boundary; it is inside '错' (bytes 1023..1026 of string)
...
test result: FAILED. 2 passed; 2 failed; 0 ignored; 0 measured
```

修复后：

```text
$ cargo test --bin noj-judge truncate
running 4 tests
test mq::tests::truncate_for_log_ascii_short_is_unchanged ... ok
test mq::tests::truncate_for_log_ascii_long_is_truncated ... ok
test mq::tests::truncate_for_log_multibyte_boundary_does_not_panic ... ok
test mq::tests::truncate_for_log_all_boundaries_do_not_panic ... ok
test result: ok. 4 passed; 0 failed
```

## Decision

把截断点对齐到字符边界（向后回退到最近的 `is_char_boundary`），与
`dual/mod.rs` 的 `ceil_char_boundary` 同一修复思路。此处保留**前 1024 字节**的
语义（日志截断意在取头部），因此用向下取整；`dual` 的硬上限语义需要向上取整，
两者方向不同、各自正确。

新增 4 条回归：

1. 短 ASCII 原样返回；
2. 长 ASCII 截断并带字节数；
3. **多字节边界**（408 个「错」= 1224 字节）不 panic —— 修复前此用例稳定 panic；
4. 遍历 `n = 1..=800` 的所有中文串长度，任意边界都不 panic（穷尽性覆盖）。

## Alternatives considered

- **复用 `dual::ceil_char_boundary`**：它在同 crate 但属 `dual` 模块的私有函数，
  且语义是「向上取整以保证硬上限」；日志截断要「向下取整保留头部」，语义相反。
  强行复用要么改其可见性、要么引入方向错误的截断。内联三行循环更清晰。
- **只加 `#[allow]` 或把 `[..1024]` 改成 `char_indices().take(1024)`**：
  `take(1024)` 会变成「1024 个字符」，与「字节上限」语义不符（日志体积失控）。
- **把 `truncate_for_log` 提升到 dual 与 mq 共用的工具模块**：正确的长期方向，
  但会引入跨模块耦合；本次先修正确性，重构留待后续。

## Consequences

- 坏消息诊断 / fallback 反序列化失败的日志路径不再 panic，诊断信息得以保留。
- `mq.rs` 行数增加（新增测试），未触及 `check-file-size.ts` 的棘轮阈值
  （该棘轮只约束已登记的巨型文件；`mq.rs` 未在其中）。
- 同类「字节切片可能落在字符边界」的模式在全仓已排查：`dual/mod.rs` 已修，
  `mq.rs` 本次修复；`sandbox/` 的 zip 解压按字节处理二进制，不涉及字符串切片。
