# Agent Note: 题目包格式 3 与单一校验实现

Status: implemented

## Problem

题目包 manifest 靠 `is_objective`、`judge_type`、`submission_mode`、`llm`
四个字段组合推断题型，校验里堆满「X 题不允许 Y」的互斥规则；每道 AI 题都要完整
抄写两个容器的镜像、时限与内存；noj-cli 在 `src/problem/vendor/` 下手工复制了约
2500 行 core 校验代码，再靠共享 fixture 契约测试防漂移，每改一条规则都要改两处。

## Decision

- 新增格式 3：`kind`（`ai` / `oi` / `objective`）单字段判别题型，取值与
  `ProblemDraftContent.kind` 一致；「通用字段 + 每题型字段」两张表替代逐条互斥
  规则，不支持的字段（含拼写错误）统一报错并列出该题型可用字段。
- AI 题 `runtime_config` 全字段可缺省，校验时用 `AI_RUNTIME_DEFAULTS` 补全；缺省
  镜像为官方 `noj-evaluator-python` / `noj-solution-python`，前缀由调用方传入
  （core 导入读取 `JUDGE_IMAGE_BASE`，与 seed-system 写入白名单的名称一致）。声明
  `llm` 即开启 evaluator 网络，显式关闭则报冲突。
- 旧格式（v1 P / v2）经纯函数 `upgradeBundleManifest` 自动转换并告警，不设删除
  时间点；该函数不注入任何缺省值，导入、`lint`、`pack` 与新增的
  `noj problem migrate` 共用。
- noj-cli 以相对路径直接引用 core 的 `problem-bundle.ts` / `runtime-config.ts` /
  `bundle-parser.ts`，删除 vendor 副本与 CLI 契约测试；fixture 移到 core 测试目录
  作为唯一行为基线。
- 返回值同时给出 `kind` 与等价的 `is_objective` / `judge_type`，下游与数据库不变。

## Alternatives considered

- **抽到顶层 `packages/problem-bundle/`**：要改动几十处 core 引用并新增顶层目录，
  收益与直接引用相同。
- **按计划在 v0.13 删除格式 2、立即删除格式 1**：会让 `noj-problems` 等存量题源
  必须先迁移才能导入；转换只是一个纯函数，长期保留成本很低。
- **缺省镜像写死 `ghcr.io/neuro-oj/...`**：本地开发与自建镜像仓库的部署不在白名单
  内，最小题包反而导入失败。

## Consequences

- 已导入的题目不受影响（存储中不保留 manifest）；旧题包继续可导入，导入结果多一条
  升级告警。
- 行为放宽：旧格式 AI 题缺 `runtime_config`、或声明 `llm` 未写网络，现在会被补全
  而不是拒绝。
- 行为收紧仅限格式 3：未知顶层字段与 `is_objective` / `judge_type` 被拒绝；旧格式的
  未知字段改为丢弃并告警。
- CLI 依赖 core 源码路径：移动这些文件时需同步 CLI 引用，CI `production-cli`
  类型检查兜底。
