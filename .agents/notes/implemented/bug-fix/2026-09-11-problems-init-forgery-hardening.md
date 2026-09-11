# Agent Note: 题目脚手架（`noj problems init`）的产物契约与防伪造加固

Status: implemented

## Problem

2026-09-11 对 PR #489 的代码评审发现该脚手架有三类问题，其中一类是**可被选手利用的评分完整性漏洞**：

1. **生成的 `evaluate.py` 可被伪造满分。** 该模板在可见用例失败时把选手控制的
   `actual_output` **原样多行回显**。judge 侧 `dual/protocol.rs` 的 `classify_line` 只在
   JSON 对象**含 `type` 字段**时才当作协议帧；`dual/mod.rs` 的 `handle_eval_chunk` 把
   `---RESULT---` 之后的**首个非空行**无条件当作结果 payload，`build_judge_result` 也不校验
   schema。因此选手只要在返回值里塞入标记行 + `{"score": 10000}`，**全部用例都错**的提交
   也会被判 `status=finished, score=10000`。已用真实生成的 evaluator 端到端复现。
   归因说明：judge 的宽松提取是根因，且既有样例题 `1001/evaluate.py` 有同样的裸回显，
   故这不是新引入的回归——但本模板会被所有后续出题人复制，等于把漏洞固化。
2. **产物契约测试是空转的。** 测试对生成物做**源码文本正则**断言（`!/return\s+json\.dumps/`、
   `replace()` 后查 `status`），实测可被绕过：写入一份完整实现、只留一处不可达的
   `raise NotImplementedError`，或用别名 + 两步 return 规避字面量，**11 个用例仍全绿**。
   且测试文件放在 `noj-core/scripts/`，而 CI 没有任何 lane 收集该目录，整套断言在 CI 中
   **永不执行**。
3. **若干产物细节与平台现状不符**：题面声明的时间限制（5000ms）与 manifest 实际生效值
   （30000ms）矛盾；用例带 `message` / `scored` 字段，但这两个键不在平台投影白名单内，
   会被静默丢弃；缺前端读取的 `visibility` 字段；默认标签 `代码实现` 未种子化，首次导入
   打印「标签已忽略」；README 第一条构建命令在全新检出时因 `data/packages/` 不存在而失败；
   默认输出根用 `Deno.cwd()`，从仓库根执行会把骨架写到 `problems build` 读不到的位置。

## Decision

**1. 回显一律经单行化助手，机制而非约定保证不可伪造。**

新增 `echo(value)`：`" ".join(str(value).split())` 压掉所有换行并限长 500 字符。换行被消除后，
回显内容**不可能**自成一行标记或 payload，伪造路径从机制上消失。所有 stdout 回显点
（`actual_output` / `expected_output` / 异常文本）全部改为 `echo(...)`，并在文件头写明
「勿改回直接插值」。stderr 不进入 judge 的 `LineParser`（只写 `stderr_buf`），不构成伪造路径，
因此仅对 stdout 做强制。

**2. 测试改为真行为验证，并移入 CI 收集范围。**

- 位置从 `noj-core/scripts/` 移到 `noj-core/tests/scripts/`——CI 的 `core-shared` 作业通过
  `bash scripts/test-shared.sh` 运行 `tests/scripts`，这是本地与 CI 覆盖一致的必要条件。
- manifest 交给**平台自己的** `validateBundleManifest`，不再手抄字段；另加一条「改坏的 manifest
  必须被拒绝」的反向用例，证明前一条不是空转。
- `template.py` 与 `evaluate.py` 的行为用**真实执行**验证：写桩 `noj_evaluator_sdk`，跑
  `python3 evaluate.py`，按 judge 的提取算法（在测试内复刻并注明依据）断言结果——包括
  「未实现模板得 0 分」「满分解得 10000」「伪造串不产生 payload」。
- 保留一条结构性断言作为快速守卫：所有 stdout 回显必须经 `echo()` 包裹，并配反向断言。

**3. 产物对齐平台现状。** 题面限制与 manifest 由同一组 `DEFAULT_LIMITS` 常量派生（单一事实源）；
用例只写投影白名单内的键（去掉 `message`/`scored`，聚合信息改走白名单内的 `summary`），并补
`visibility`；默认标签改为已种子化的 `入门`；slug 增加 64 字符上限；占用检查改用 `lstat`
（拒绝符号链接，避免写到 `--dir` 之外）、区分「文件占用」与「非空目录」；写入用 `createNew`
并在失败时回滚；默认输出根与 `noj.ts` 的 `SRC_DIR` 用同一套推导。

## Alternatives considered

- **以「选手输出不得含标记行」为校验，而不是压成单行。** 否决：识别「伪造」需要 judge 侧理解
  语义，而模板运行在容器内、拿不到 judge 的判定逻辑；单行化是纯结构性约束，不依赖语义判断。
- **在 judge 侧收紧 payload 提取（要求 payload 是最后一行且匹配 `{"score": int}` schema）。**
  这是更根本的修复，但会改变所有既有评测脚本的兼容边界，且属 noj-judge 的行为变更，不宜与
  脚手架 PR 混在一起。本 PR 只做模板侧加固，judge 侧硬化另开跟踪。
- **把 `message` / `scored` 加进平台投影白名单，保留模板的友好失败原因。** 否决：那会扩大到
  所有提交结果的契约面，需要单独评审；且 `summary` 已在白名单内，足以承载整体说明。模板改为
  只写白名单内的键，避免「写了却被静默丢弃」这类更难发现的失真。
- **沿用源码正则断言，只把正则写得更严。** 否决：正则无法区分「未实现」与「恰好看上去未实现」，
  实测已被两种简单改写绕过；真执行才能锁定行为。
- **为 py3 依赖加 `ignore` 守卫。** 否决：那正是本仓库反复出现的「静默跳过」反模式。python3
  缺失时 `Deno.Command` 抛错使测试失败，是期望行为；`zip` 已有同类系统依赖先例。

## Consequences

- 新生成的骨架默认**不可**被选手通过回显伪造 RESULT；已用端到端复现验证（修复前 judge 提取到
  伪造 payload 判满分，修复后提取为 `null`）。
- `tests/scripts/problems-init_test.ts` 进入 CI 覆盖；测试数 11 → 19，且新增断言均锚定可证伪
  行为（其中 4 条在实现修复前实测失败，证明其有效性）。
- 测试套件新增 python3 运行期依赖；CI 的 `ubuntu-latest` 自带，本地缺失时会显式失败而非跳过。
- 骨架不再向平台发送被丢弃的字段，出题人不会误以为失败原因已展示；整体说明改由 `summary` 承载。
- judge 侧 payload 提取的宽松性**仍然存在**（既有样例题同样暴露）。本 Note 记录该风险已知且
  未在本 PR 内修复，需单独跟踪；在此之前，任何新评测脚本都必须遵守「不回显选手多行输出」。
