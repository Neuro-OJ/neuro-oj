# 教学矩阵性能基线记录

日期：2026-10-13。当前范围为开发分支的实际 HTTP 应用组合与后端读取。

## 环境

- AMD Ryzen 7 H 255，8 核 16 线程，Linux x86_64。
- Docker PostgreSQL 16.15，独立数据库
  `noj_upgrade_contest_parallel_20261013`，隔离 schema
  `test_education_perf_root_20261013`。
- Redis DB 7；测试存储使用 local。
- 当时同时运行模块测试及 Rust 编译，本结果不代表空载独占机器。

## 数据与结果

100 名学生、50 道题、5,000 份有正式判定的提交，10,000 个按时和补做进度单元。
教师矩阵按 50 名学生分页，每次完整返回当前页 2,500 个单元。

两次预热后采样 20 次，页面交替读取：p95 **64.42 ms**，最大 **65.03 ms**，
满足后端分页读取 p95 ≤2 秒的目标。计时包括实际 createApp 的认证、查询和 JSON
编解码，不包含 TCP/TLS、浏览器渲染和大量在途重测压力。

同一用例还验证授权 CSV 覆盖完整 100 人名单、流式导出中的撤权和班级归档。
该记录不代替浏览器验收。正常进度更新在下述追加场景中独立验证。

## 同数据量的正式重测与后台进度更新

在独立数据库 `noj_upgrade_regression_20261013d`、schema `root_education_perf_5s`
及临时隔离 Redis 的 DB 11 重跑同一标准性能用例。 数据量保持 100 人、50 题、5,000
份正式提交和 10,000 个进度单元；当时其他 agent 同时运行模块验证。

矩阵重新采样 20 次：p95 **100.36 ms**，最大 **103.60 ms**，继续满足 ≤2 秒。

随后为已有提交创建新的正式重测尝试（65 分、未 AC），更新其版本结果桶，并
通过实际提交投影门面写入正式成绩与持久教学事件。启动真实后台消费者，读取
数据库直到按时与当前两个进度单元均采用新尝试、65 分及达标状态。

该次从正式结果写入开始，到两个进度单元更新完成为 **1,623.94 ms**，满足 ≤5 秒。
保留后台的正常领取、游标和空队列等待，不直接调用成绩重算替代消费者。
计时包含消费者启动与既有作业发布事件处理，不包含 Judge 执行代码的耗时。
这是一份固定环境单次更新记录，不是生产流量下的更新延迟 p95。

标准过滤入口实际通过，日志：`/tmp/noj-root-education-perf-5s-20261013.log`。

## 复现

仅在可清理的隔离库执行，测试夹具会重置隔离 schema：

```bash
cd noj-core
DATABASE_URL=postgres://noj:noj@127.0.0.1:5432/noj_upgrade_contest_parallel_20261013 \
TEST_SCHEMA=test_education_perf_root_20261013 \
REDIS_URL=redis://127.0.0.1:6379/7 STORAGE_PROVIDER=local \
NOJ_RUN_PERF=1 NOJ_PERF_ALLOW_EXTERNAL_DB=1 deno task test:domain education
```

日志：`/tmp/noj-root-education-performance-final.log`。该路径为本地验证记录，
正式交付还需保存 CI 结果及完整发布验收报告。
