# E2E 测试指南

## 概述

本目录包含 neuro-oj 的全链路端到端（E2E）集成测试，验证从提交代码 → MQ 分发 →
Judge 评测 → 结果回写 → 数据库持久化的完整流程。

此外，`e2e/browser/` 提供 **UI 浏览器关键流程门禁**（issue #427）：通过
Playwright 真实操作浏览器，覆盖 API E2E 无法触达的页面交互：

1. 注册 → 跳转邮箱验证页（`registered=1&sent=1`）
2. 登录 → 退出（UserMenu → 确认弹窗）
3. 代码提交 → 评测结果（编辑器提交 → 侧栏满分卡片）
4. 核心失败反馈（错误答案 → 已完成且非满分）

运行方式：

```bash
# 前置：完整评测栈已启动（scripts/e2e/setup.sh），noj-ui 已构建并监听 :3000
cd noj-ui && NUXT_API_BASE=http://localhost:8099 PORT=3000 deno task preview  # 或 node .output/server/index.mjs
cd noj-tests
deno run -A npm:playwright install chromium   # 首次安装浏览器
NOJ_RUN_BROWSER_E2E=1 deno task test:browser
```

失败时自动在 `noj-tests/test-results/ui-browser/` 保存 trace + 截图诊断产物。 CI
中由 `.github/workflows/e2e.yml` 的「UI 浏览器关键流程门禁」步骤执行， Fork PR
无需任何生产凭据（issue #427 验收项）。

### 测试架构

```
noj-tests/
├── deno.json                  # Deno 项目配置（test:domain 任务）
├── E2E_TESTING.md             # 本文档
├── run-e2e.sh                 # 本地全量运行脚本
├── scripts/
│   └── run-e2e-domain.sh      # 按 Domain 运行（CI 与本地同一命令）
└── e2e/
    ├── helper.ts              # 共享辅助函数（API 客户端、注册、e2eTest 包装）
    ├── identity/              # 认证、用户主页、改密守卫、密码重置、头像、TFA
    ├── catalog/               # 标签、题目、题目模板、题包导入、题单
    ├── submission/            # 提交、队列、SSE、重测、双容器、支持包、调用超时、优先级队列
    ├── contest/               # 竞赛生命周期、榜单、答疑、防作弊
    ├── system/                # 签到、审计日志、公告、自测
    ├── community/             # 社区（帖子/评论/审核/动态流）
    ├── messaging/             # 站内私信
    ├── objective/             # 客观题
    ├── admin/                 # 管理端点
    ├── cross-domain/          # 跨域链路（全管道、RBAC、搜索、网络能力、双容器、LLM 网关）
    ├── browser/               # 浏览器流程（需 noj-ui 已构建并监听 :3000）
    ├── staging/               # staging 验收清单（由 scripts/staging/acceptance.sh 执行，不进 CI）
    └── support-package/       # 测试用支持包参考
```

每个目录对应一个 CI job（`e2e-<domain>`）；共享的 `helper.ts`、`scripts/**`、
`deno.json` 归入 `e2e-infra`，改动它们会触发全部 API 与浏览器 E2E。

### 测试覆盖

| 测试文件                           | 测试内容                           | 关键验证点                                                                                           |
| ---------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `01_tags.test.ts`                  | 标签 CRUD/合并/筛选 + 算法标签门控 | 打标签→筛选命中→合并/删除清理；匿名/未 AC 隐藏、AC 后可见                                            |
| `02_problems.test.ts`              | 题目 CRUD + U/P 型 + 筛选          | 题型分离，URL 驱动筛选                                                                               |
| `03_auth.test.ts`                  | 登录/注册/改密/管理员              | JWT Cookie，强制改密守卫                                                                             |
| `04_submissions.test.ts`           | 提交流程 AC/WA/TLE                 | 评测结果正确性                                                                                       |
| `05_profile.test.ts`               | 用户主页信息统计                   | 通过数，AC 率                                                                                        |
| `06_pipeline.test.ts`              | 全管道端到端                       | 提交→MQ→评测→结果→DB                                                                                 |
| `07_queue.test.ts`                 | 队列可见性 + MQ 可靠性             | 队列状态，非法消息容错                                                                               |
| `08_password_change_guard.test.ts` | 强制改密守卫                       | 改密前访问限制                                                                                       |
| `09_checkin.test.ts`               | 每日签到                           | 连续签到天数计算                                                                                     |
| `10_sse.test.ts`                   | SSE 推送                           | 提交/队列/统计事件流                                                                                 |
| `11_messaging.test.ts`             | 站内私信                           | 会话/消息/已读/删除                                                                                  |
| `12_audit_log.test.ts`             | 审计日志                           | 管理操作留痕                                                                                         |
| `13_support_package_s3.test.ts`    | 支持包 S3 存储                     | presigned URL 下载                                                                                   |
| `14_rejudge.test.ts`               | 重测                               | 单题/整题重测                                                                                        |
| `15_dual_container_judge.test.ts`  | 双容器评测                         | Evaluator + Solution                                                                                 |
| `16_community.test.ts`             | 社区                               | 帖子/评论/审核/动态流/通知                                                                           |
| `17_problem_template.test.ts`      | 题目模板                           | 代码模板注入                                                                                         |
| `18_search.test.ts`                | 全局搜索                           | 题目/用户/社区检索                                                                                   |
| `19_admin_endpoints.test.ts`       | 管理端点                           | 用户/题目/黑名单等                                                                                   |
| `20_password_reset.test.ts`        | 密码重置                           | 邮件令牌流程                                                                                         |
| `21_rankings.test.ts`              | 榜单                               | 全局/竞赛排名                                                                                        |
| `22_contest_lifecycle.test.ts`     | 竞赛生命周期                       | 创建/报名/提交/封榜/解封                                                                             |
| `23_network_capability.test.ts`    | 评测网络能力                       | evaluator 联网与 capability                                                                          |
| `24_import_bundle.test.ts`         | 题目包导入                         | 统一题目包                                                                                           |
| `25_rbac.test.ts`                  | RBAC 权限                          | 角色/权限/继承                                                                                       |
| `26_call_timeout.test.ts`          | 调用级超时                         | call_timeout_ms 生效                                                                                 |
| `32_llm_gateway.test.ts`           | LLM Gateway 全链路                 | Provider → P 型 LLM 题 → 提交 → gateway → Mock LLM → 用量落库；U 型/未开网络拒绝；重测重新签发 token |

## 前置条件

- Docker 及 Docker Compose V2
- 无需手动启动任何服务（测试自动管理）
- 本地启动时会自动从当前工作树刷新 `noj-evaluator-python` 与
  `noj-solution-python` SDK 镜像，无需手动执行构建脚本

## 运行方式

### 按 Domain 运行（与 CI 一致）

```bash
cd noj-tests
deno task test:domain submission      # 等价于 bash scripts/run-e2e-domain.sh submission
```

可用 domain：`identity` / `catalog` / `submission` / `contest` / `system` /
`community` / `messaging` / `objective` / `admin` / `cross-domain` / `browser` /
`staging`。

> 本地运行需要完整的 E2E 栈（`env.e2e.template` 会设置 `NOJ_RUN_E2E=1`）；
> 栈未启动时用例会被静默跳过，请先 `bash ../scripts/e2e/setup.sh`。

### 一键运行所有 E2E 测试（本地全量）

```bash
cd noj-tests
NOJ_RUN_E2E=1 deno task test
```

启动脚本回归检查：

```bash
bash ../scripts/e2e/check-setup.sh
```

### 保留容器（调试用）

```bash
E2E_NO_CLEANUP=1 NOJ_RUN_E2E=1 deno task test
```

测试结束后容器保留，可手动排查问题。

### 调试技巧

```bash
# 查看 noj-core 日志
docker compose -f ../docker-compose.e2e.yml logs -f noj-core

# 查看 noj-judge 日志
docker compose -f ../docker-compose.e2e.yml logs -f noj-judge

# 手动进入 noj-core 容器
docker exec -it noj-e2e-core sh

# 手动启动/停止栈
docker compose -f ../docker-compose.e2e.yml up -d
docker compose -f ../docker-compose.e2e.yml down -v
```

## 环境变量

| 变量                  | 默认值                  | 说明                        |
| --------------------- | ----------------------- | --------------------------- |
| `NOJ_RUN_E2E`         | —                       | 设为 `1` 启用 E2E 测试      |
| `E2E_BASE_URL`        | `http://localhost:8099` | noj-core 地址               |
| `E2E_NO_CLEANUP`      | —                       | 设为 `1` 不自动清理容器     |
| `E2E_JWT_SECRET`      | `e2e-test-secret`       | JWT 签名密钥                |
| `NOJ_RUN_BROWSER_E2E` | —                       | 设为 `1` 启用 UI 浏览器门禁 |
| `E2E_UI_URL`          | `http://localhost:3000` | noj-ui 地址（浏览器门禁用） |

## CI 集成

E2E 测试在 `.github/workflows/e2e.yml` 中定义，在 PR 和推送到 main 时运行。

## 相关测试

- **noj-judge Rust E2E
  测试**：`cd noj-judge && NOJ_RUN_E2E=1 cargo test -- --ignored`（低层 Docker
  沙箱行为）
- **noj-core API E2E
  测试**：`cd noj-core && deno test -A tests/e2e/api.test.ts`（33 个 HTTP API
  测试）
