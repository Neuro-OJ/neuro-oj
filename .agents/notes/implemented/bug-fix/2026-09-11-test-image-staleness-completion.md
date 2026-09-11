# Agent Note: 测试镜像陈旧判定的收尾——覆盖 ensure_test_image 并把判定纳入测试

Status: implemented

## Problem

PR #492 把 SDK 测试镜像的陈旧判定从「tag 是否存在」改为「构建输入内容哈希」，
但评审发现该修复**只做了一半**：

1. **`ensure_test_image` 未一并修改。** 它仍以「tag 存在即跳过」判定，而
   `noj-judge/tests/` 的 8 个需要 Docker 的 E2E binary 中有 **6 个**依赖它
   （e2e_support_package、e2e_security_isolation、e2e_resource_limits、
   e2e_docker_basic、e2e_dual_container、e2e_network_capability）。
   其构建输入是 `tests/e2e/Dockerfile.test-runner`（构建上下文 `tests/e2e`），
   而最常被改动的 `tests/e2e/evaluate.py` 就在其中。**改了 evaluate.py 仍会静默
   验证旧镜像**——与被修复的那个缺陷完全同类。实测确认：本地
   `noj-judge-test-runner:latest` 无任何 label。

2. **陈旧判定本身没有测试。** 7 个既有用例只覆盖 `build_inputs_sha`（哈希函数），
   而「哈希相不相等 → 该不该重建」这一决策写死在 `ensure_sdk_images` 循环里，
   只能靠跑 Docker 覆盖。后果：把判定写反、或删掉 `--label` 参数，
   **不会让任何用例失败**，而两者都会静默破坏整套 E2E 的可信度
   （前者变成"永不重建"，后者变成"永远重建"）。

3. **`__pycache__` 的过滤理由陈述是错的。** 注释称 pycache「不参与镜像内容
   （镜像内 PYTHONDONTWRITEBYTECODE=1）」，实测 evaluator 镜像内
   **有数百个 .pyc**（构建期 `python3 -c "import ..."` 生成，外加从构建上下文
   复制进来）。理由错了，后人若据此"修正"过滤器就会引入永久重建抖动。

4. **「跳过重建」不可见。** 原实现只在**重建**时打印，跳过时静默——
   日志上无法区分「判定为最新而跳过」与「这个函数根本没被调用」，
   而这正是本项目此前踩过的「静默跳过」模式。

## Decision

**1. `ensure_test_image` 改用同一机制。** 抽出模块级常量 `INPUTS_LABEL`
（`com.noj.build-inputs-sha`）与原语 `recorded_inputs_sha()`，两个 `ensure_*`
共用。测试镜像的构建输入为 `tests/e2e` 全目录（含 evaluate.py）+
`Dockerfile.test-runner`。

**2. 把判定抽成纯函数并单测。** 新增
`decide_image_freshness(expected, recorded) -> UpToDate | Rebuild(reason)`，
配 5 个用例：无 label 重建、哈希一致跳过、哈希不同重建、空字符串 label 视为
「已变更」而非「缺失」、判定确定性。语义固定为**安全方向**：无法证明最新就重建。
`ImageFreshness::Rebuild` 携带原因，直接进日志。

**3. 构建后复核 label 已生效。** 若 docker 忽略 `--label`（版本差异或被策略剥离），
每轮都会「看起来重建成功」但下次判定仍为缺失 → 永久重建循环。与其静默循环，
不如立即 `bail!` 并说明原因。

**4. 让「跳过」可见。** 两条路径都打印，并带上哈希前缀：
`已是最新（构建输入 1d6dcbe89a5a…），跳过重建`。哈希前缀还让"验证的是哪一版"
在日志里可追溯。

**5. 订正 `__pycache__` 的过滤理由**，写明这是「接受漏掉一个派生文件、换取避免
永久重建抖动」的取舍，以及何时才能移除该过滤。

## Alternatives considered

- **把 `tests/e2e` 整个目录的哈希算作输入，不再单独列 Dockerfile。**
  实际已如此（Dockerfile 在上下文内，会被 `collect_files` 一并纳入）。
- **构建后不复核 label，只依赖 `--label` 的文档行为。** 否决：失败的形态是
  「每轮静默重建」，既慢又不会被发现；一次 `inspect_image` 的成本可以忽略。
- **把判定逻辑留在 `ensure_*` 内，用 Docker 集成测试覆盖。** 否决：那意味着
  该决策只在有 Docker 的环境被测到（CI 的 judge-check 作业**没有** Docker），
  等于没测。纯函数可以在任何环境快速验证。
- **不打印「已是最新」。** 否决：与"跳过未执行"无法区分，正是本仓库反复出现的
  静默模式；一行日志即可消除歧义。
- **把 `__pycache__` 加进 `.dockerignore` 使镜像不含它，从而移除过滤器。**
  更彻底，但会改变镜像内容（影响现有 E2E 行为），超出本次修复范围，已记入
  注释作为后续可选项。

## Consequences

- 改 `tests/e2e/evaluate.py` 或 `Dockerfile.test-runner` 现在会**触发重建**，
  6 个依赖该镜像的 E2E binary 不再可能验证旧镜像。实测验证：改动 evaluate.py 后
  首次运行输出「构建输入已变更 → 重建」，恢复后输出「已是最新，跳过」。
- 陈旧判定有 5 个单测；把判定写反会立即失败（已用变异测试确认）。
- label 未生效时立即报错，不会退化为每轮静默重建。
- 每次 E2E 的日志都能回答「这一轮验证的是哪个镜像版本」。
- judge 测试数 285 → 389（`tests/common/mod.rs` 被每个集成测试 binary 编译，
  故新增用例在所有 binary 中各计一次）。
- 未做：`.dockerignore` 的 pycache 排除、SDK 镜像内容对 `apt-get upgrade` 的
  镜像源漂移（哈希无法感知，属既有性质，已在注释中说明取舍）。
