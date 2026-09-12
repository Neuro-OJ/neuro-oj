# Agent Note: JudgeTask 单一构造入口与跨模块契约快照

Status: implemented

## Problem

`JudgeTask` 两侧各写一份（TS `domains/submission/types/index.ts` / Rust `types.rs`），且由 **6 处内联字面量**构造（`submissions-crud` / `submissions-rejudge`×2 / `artifact-submissions` / `self-tests` / `sweeper`）。新增字段要同时改 6 处 + Rust 结构体，靠人工记忆；失败模式是**静默的**——Rust 侧 `Option`/`#[serde(default)]` 会把缺失字段化为默认值。`types.rs` 的对齐注释还指向已不存在的 `noj-core/src/types/index.ts`（3 处），说明对齐纯属人工约定，无任何校验。

## Decision

1. 新增 `buildJudgeTask()` 作为唯一构造入口（可选字段仅在有值时写入，保持消息体最小），6 处内联构造全部收敛；`JUDGE_TASK_FIELDS` 登记 wire 字段集。
2. 新增两侧共用的契约 fixture `noj-tests/fixtures/judge-task.contract.json`：
   - TS 侧 `judge-task-contract.test.ts`：工厂按 fixture 构造出的消息必须与 fixture 完全一致；字段集合必须与 `JUDGE_TASK_FIELDS` 一致；可选字段缺省时不出现在消息体。
   - Rust 侧 `noj-judge/tests/judge_task_contract.rs`：必须能反序列化同一 fixture 并取到全部字段值；fixture 字段集与结构体期望一致；缺必填字段必须反序列化失败。
3. 修正 `types.rs` 3 处失效路径注释，指向真实路径与两份快照测试。

## Alternatives considered

- 从 TS 类型生成 JSON Schema 供 Rust 校验：更彻底，但需要引入 codegen 链路与构建步骤，本次先以"共用 fixture + 两侧断言"达成同等防护。
- 用 `deny_unknown_fields`：会让 core 先发布新字段时 judge 直接拒收消息，与"向后兼容滚动升级"冲突，改由测试断言字段集。
- 只做 Rust 侧测试：字段名漂移在 TS 侧新增时无法发现。

## Consequences

新增字段只需改 `buildJudgeTask` + Rust 结构体 + fixture（测试会提示）。Rust 侧测试读取 `../noj-tests/fixtures/`（cwd = crate 根，`CARGO_MANIFEST_DIR` 解析）。
