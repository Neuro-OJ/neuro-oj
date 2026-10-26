# 2026-10-16 LMCC 模拟赛热修复记录

- 比赛：`ct-kva2vbmr`（「[LMCC-T 模拟赛] 终将成为你 (With GPU)」，UTC
  12:00–16:00）
- 题目：A = P23（界面题）、B = P24（预测题）、C = P25（代码题）
- 生产主站：noj-cli 安装目录，core 镜像
  `noj-local/noj-server:contest-access-20261016`
- 独立评测节点：`noj-judge1`（i5-12400 / 16G）
- 时间均为 UTC

## 总览

| # | 问题                                      | 处理                                                        | 状态                       |
| - | ----------------------------------------- | ----------------------------------------------------------- | -------------------------- |
| 1 | P23 所有提交评测出错                      | 数据恢复（发布 V2 + 竞赛切版本 + 整题重测）；代码修复待部署 | 数据已修复，代码待赛后部署 |
| 2 | 重测时 1 条提交因 LLM 网关断连出错        | 单条重测                                                    | 已修复（100 分）           |
| 3 | 平台错误需要人工重测                      | 自动重试最多 3 次（开发中）                                 | 未完成，未部署             |
| 4 | T3（P25）重置代码提示「没有初始代码模板」 | 数据恢复（发布 V2 + 竞赛切版本）                            | 已修复                     |
| 5 | judge1 AI 并发偏低（2）                   | 调到 6                                                      | 已生效                     |
| — | P24 同样提示没有模板                      | 题源本来就没有模板，属正常                                  | 无需处理                   |

---

## 1. P23 所有提交评测出错（根因：编辑器清空界面题模板）

### 现象

- `sub-4c6x933g` 等 P23 的全部提交都是 `error`，评测尝试
  `result_kind = platform_error`； 修复前累计 24–26 条。
- 评测器报错：

  ```text
  File "/workspace/evaluate.py", line 84, in main
      config = runner.call("get_config")
  noj_evaluator_sdk.errors.NotFoundError: function 'get_config' not registered
  ```

- 同一时段其他题目（P12/P17/P19/U3–U5 等）评测正常，评测机本身没有问题。

### 根因

1. 界面题的选手脚本由「选手参数 + 题目模板
   `template_content`」拼接而成（`ui-solution.ts`）， `get_config()`
   定义在模板里。
2. P23 在 13:43 通过 `noj-cli problem push` 导入，这时模板写入正确；14:22
   有人在网页编辑器里保存并发布了 V1。
3. `noj-ui/components/editor/CodingProblemEditor.vue` 的 `buildContent()`
   每次保存都发送 `template_content: ""`，core 的 `PUT /problems/:id/draft`
   原样写入，所以 V1 的模板是空的。
4. 版本不可变，所以 V1 上的每次评测都缺少 `get_config` 而出错。
5. 这和服务端已有的约定矛盾：`updateProblem`
   规定模板只能由题包导入写入，但草稿接口没有执行这条规则。

### 数据恢复（已上线）

不依赖部署新代码，在生产环境用临时容器直接调用 core 服务函数执行，审计 actor 为
`chenmou2012`：

1. 用题源 `noj-problems/lmcc-mock1-date-normalize/template.py`
   恢复草稿模板（revision 4 → 5）。
2. 发布 **V2**：`3a67a6ae-4da5-494f-80f8-9d33176c80e7`。
3. 竞赛 A 题固定版本 V1（`606c6046…`）→ V2，策略保持 `any`。
4. 先单独重测 `sub-4c6x933g`（`target=latest`）：`graded`，90 分。
5. 整题重测 P23（任务 `0d69706d-6714-47b9-8d43-84e34620e3f6`，26 条）：25 条直接
   `graded`， 1 条因 LLM 网关断连出错（见第 2 节）。

验收：P23 的提交在 V2 上全部正常出分，满足「这道题可以正常评测」。

### 代码修复（已提交，未部署）

- 提交 `782b8f43`（GPG
  签名）`fix(core): 编辑器保存草稿不再清空题包导入的界面题模板`，分支
  `worktree-agent-a844e8d64c3cbfc65`。
- `saveProblemDraft` 新增 `fromClient`：只有 `PUT /problems/:id/draft` 传
  true，此时 AI 题的 `template_content`
  以当前草稿为准（没有草稿行时以最新版本为准），忽略客户端传入的值。
- 回归测试覆盖：编辑器传空模板时保留原模板；客户端伪造模板被忽略；发布后的版本带模板；派发草稿保留模板。
  `deno task test:domain catalog`：358 通过 / 0 失败。fmt、lint、check 通过。
- 前端侧：`main` 已合入 #665
  `fix(ui): 题目编辑器保存草稿时保留题包模板`，与本修复互为双保险。
- 只需重新部署 **core**，没有迁移。

> 新 core 上线前，**不要用网页编辑器保存或发布 P23 /
> P25**，否则模板会被再次清空。

---

## 2. 重测中 1 条提交因 LLM 网关断连出错

- 提交 `2de401c3-5d82-4c3b-85c7-488635da7dfa` 在 V2 上重测时报
  `noj_evaluator_sdk.llm.LLMError: LLM gateway 连接失败: Remote end closed connection without response`，
  评测器没输出 `---RESULT---`，判为 `platform_error`。这和模板问题无关。
- 处理：单独再次重测（任务 `561a6b11-877c-464f-810b-3feb8a694b07`），结果
  `graded` 100 分。
- 网关日志里没有对应报错，推测是评测机到网关的转发链路偶发断开，尚未定位到具体原因。

## 3. 平台错误自动重试（开发中，未完成）

- 用户需求：评测出错的提交自动重试，最多 3 次。
- 子代理在 `worktree-agent-adb1d4906a249b20c` 中实现，改动涉及
  `consumer.ts`、`pending-recovery.ts`、
  `sweeper.ts`、`submissions-result.ts`、`result-write.ts`，新增 `auto-retry.ts`
  和 `settings-registry` 配置项。重试计数持久化在 DB，满足多副本约束。
- 进度：submission 域测试 336 通过（新增 8 个用例）；fmt、lint、check
  和跨域测试**还没跑**，**尚未提交**。
  子代理因为会话额度用尽中断，需要在额度恢复后继续。
- 部署：与第 1 节的代码修复一起，赛后打进新 core。

---

## 4. T3（P25）重置代码提示「该题目没有初始代码模板」

### 根因

和第 1 节相同：P25 导入后在网页编辑器里保存并发布了 V1，模板被清空。

### 数据恢复（已上线）

1. 题源对应关系以 `noj-problems/push-mock1.sh` 为准：P25 =
   `lmcc-mock1-class-fund`，模板为 `template.py`（3868 字符）。
2. 只读预检：草稿 revision 3，除模板外与固定版本 V1 逐项一致；题面与
   `statement.md` 逐字节一致。
3. 执行：保存草稿模板 → 发布 **V2** `007726c1-6c40-46f5-b0b7-78912d50cff1` →
   竞赛 C 题固定版本 V1（`59360fef…`）→ V2。
4. 修复时 P25
   还没有任何提交，不需要重测，排名不受影响。代码题的评测不使用模板，只影响编辑器的初始代码。

### P24 无需处理

P24（`lmcc-mock1-rising-digits`，预测题）的 problem.json 里没有 template
字段，题包里也没有模板文件。
空模板就是导入时的原样，提示「没有初始代码模板」属于正常行为。

---

## 5. 评测机并发

### 现状（调整前）

| 节点                                      | AI 并发 | 资源池    | 内存预算 |
| ----------------------------------------- | ------- | --------- | -------- |
| 主站 `noj-core-240`（`noj-prod-judge-1`） | 4       | AI        | 4096 MiB |
| `noj-judge1-i5-12400`                     | 2       | AI + WASM | 8192 MiB |

### 调整

- `noj-judge1` 的 `/srv/noj-judge/.env.judge` 和 `docker-compose.judge.yml` 中，
  `JUDGE_AI_TASK_CONCURRENCY` 从 2 改为 **6**。备份为 `*.bak-20261016-214157`。
- 重启 `noj-judge-worker` 后，worker 报
  `资源组容量或内存预算与其他 Worker 不一致；排空并协调更新后再启动`，一直在重启：Redis
  里 `noj:judge:resources:noj-judge1-i5-12400:config` 还是旧容量。
- 处理：确认这个资源组的心跳和租约都已过期后，用 judge 源码
  `Scheduler::reset_group_config` 里的同一段 Lua 脚本原子清除旧配置。worker
  随即正常启动，Redis 里的配置变为 `ai_tasks: 6`。
- judge1 大约有 1.5
  分钟（13:42–13:43:50）没有接任务，期间评测由主站评测机处理，没有任务丢失。

> 以后调整资源组容量，都需要先排空 worker，再清除
> `:config`，然后启动。建议把这一步做成 `noj-cli judge` 的维护命令。

---

## 6. 操作过程中的意外

- 排查时在 `noj-prod-core-1` 里执行了
  `noj-server --help`。这个二进制不认识这个参数，直接启动了第二个 core
  实例：跑了一遍迁移检查（没有新迁移），短暂启动了消费者，大约 2
  秒后因为端口被占用退出。线上 core 一直是 healthy，没有发现评测卡住。
- 第一次做数据恢复时让用户在终端登录，脚本误报「登录失败」：其实服务端登录成功了，但经过
  Nitro 代理后 token 只放在 Cookie
  里，响应体里没有。之后改为在服务器上用临时容器执行，不再需要账号凭据。
- 生产 core 容器的根文件系统是只读的，所以热修复脚本都通过
  `docker run --rm --network noj-prod_noj-net --env-file <core 环境>`
  起临时容器执行； 执行后已删除带凭据的临时 env 文件和二进制。

---

## 待办

1. [ ] 自动重试子代理在额度恢复后继续：跑完 fmt、lint、check 和相关域测试，GPG
       签名提交，写 Agent Note。
2. [ ] 赛后（UTC 16:00 之后）基于线上 core 的源码基线构建新 core，包含
       `782b8f43` 和自动重试： 打包为 `noj-local/noj-server:<tag>` 并替换
       core，保留旧镜像用于回退。
3. [ ] 新 core 上线后验收：在编辑器保存一次 P23 草稿，确认
       `GET /api/v1/problems/P23/draft` 的 `template_content` 仍然非空。
4. [ ] 两项代码修复走 PR 合入 `main`（`main` 已有 #665 前端侧修复）。
5. [ ] 排查评测机到 LLM 网关偶发 `Remote end closed connection` 的原因。
6. [ ] 更新服务器 `LOCAL-PATCHES.md`，记录本次数据变更（P23 V2、P25 V2）和
       judge1 并发调整。
