## Context

见 proposal.md。测试依赖由 dev-setup 导入的示例题；题号变更后测试引用必须同步。

## Goals / Non-Goals

**Goals:**

- 让 E2E 使用实际存在的 A+B 示例题。

**Non-Goals:**

- 不修改题目、导入逻辑或评测实现。

## Decisions

- 以 P1001 作为 A+B 的唯一 E2E
  固定题号，避免两个模板测试引用同一展示题号却期待不同题目。

## Risks / Trade-offs

- [未来再调整示例题号] → 测试基准仍需同步更新；本变更不引入新的动态查找机制。
