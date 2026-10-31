# Agent Note: 旧无域比赛 API 下线评估（0.11 RC）

Status: implemented

## Problem

0.11 把所有比赛读写收敛到显式域路径 `/api/v1/domains/:slug/contests/...`，但
`/api/v1/contests/*`（无域前缀）**没有下线**：写方法进了退役清单，读方法原样保留。
于是发布前有一个没人量化过的问题——**旧读接口还有多少第一方调用方？现在能不能直接删？**

不能靠"看起来没人用"回答。评估需要可核对的清单：哪些路由还在、哪些已被谁调用、
哪些调用会在生产环境静默失效。为此先做了一次静态清点（脚本
`scripts/check-legacy-contest-api.ts`，已进门禁）。

清点结果（2026-10-31，`rc/v0.11`）：

| 类别 | 数量 | 明细 |
| --- | --- | --- |
| 仍在服务的只读路由 | 8 | `GET /`、`GET /:id`、`GET /:id/problems`、`GET /:id/problems/:label`、`GET /:id/ranking`、`GET /:id/final-ranking`、`GET /:id/my-submissions`、`GET /:id/clarifications` |
| 已退役的写路由 | 5 | `POST /`、`POST /:id/register`、`POST /:id/submit`、`POST /:id/clarifications`、`POST /:id/clarifications/:clarId/reply` |
| 第一方生产调用方 | 2 个文件 / 4 处 | `noj-ui/pages/editor/[id].vue`（3 处）、`noj-ui/utils/editorHistory.ts`（1 处） |
| 测试引用 | 37 处 | `noj-tests/e2e/contest/*` 等，只在非生产环境跑 |

另外三个事实决定了"删除"不能拍脑袋：

1. **退役只在生产生效。** `createApp()` 的 `retireLegacyEndpoints` 默认取
   `NOJ_ENV === "production"`，E2E 跑在非生产环境，所以 `noj-tests` 里那 37 处写调用
   仍然返回 201——它们通过并不能证明退役契约成立，反过来也不能证明删除安全。
2. **旧编辑器入口已经坏了一半。** `/editor/:id?contest=<id>&label=<label>` 的提交仍打
   `POST /api/v1/contests/:id/submit`，而该路由在生产返回 410。也就是说这个深链接在
   生产环境**根本无法提交**，只是一直没人从 UI 走到它（全仓库没有指向它的链接）。
3. **授权口径绑死在默认域。** 旧入口读路径经 `resolveDefaultContestAccess`，固定
   `main` 且拒绝其他域的比赛；把它"顺手改成域无关"会越权，不是清理。

## Decision

0.11 **不删除**旧读接口，但把它降级为"已知无人使用、且被门禁锁死"的遗留面：

1. **收掉旧编辑器入口**：新增 `noj-ui/middleware/legacy-contest-editor.ts`，在渲染前把
   `/editor/:id?contest=&label=` 301 到 `/d/main/contests/<id>/solve/<label>`。目标固定
   `main` 是因为旧读入口本来就只服务默认域；换成别的 slug 会把旧链接指向它无权访问的
   比赛。改了提交不可用的入口，而不是给它补一条新写路径。
2. **后台读接口迁到管理端**：`admin/problem-versions.vue` 与
   `admin/submission-jobs.vue` 改用 `GET /api/v1/admin/contest/contests/:id`（该端点已
   返回 `problems`，同样接受 public_id），不再依赖旧读接口。
3. **加门禁**：`scripts/check-legacy-contest-api.ts` 断言两件不会随实现漂移的事实——
   写方法必须全部在 `retired-endpoints.json` 登记；第一方生产代码不得新增
   `/api/v1/contests` 引用（现存两处白名单写明了"不可达 + 随 0.12 删除"）。白名单条目
   一旦不再引用就会报陈旧，逼着下线时一起清空。
4. **读接口下线排在 0.12**；前置条件登记在
   `noj-docs/docs/features/contests.md`：先删除 `editor/[id].vue` 的 `isContest` 分支与
   `editorHistory` 的竞赛分支（当前不可达，属于过渡代码），再让无域读路由返回 410 并
   观察一个版本。

## Alternatives considered

- **0.11 直接删旧读路由**：两处过渡代码仍在仓库里（虽不可达），删路由会让 410 出现在
  编辑器分支上；且第三方集成没有任何仓库内证据可证，把"仓库里没人用"当成"没人用"是
  评估里最典型的自欺。
- **保留并在文档里写"已废弃"**：这正是 0.11 之前的状态。没有门禁的"废弃"只是注解：
  实测过 0.11 之前无域写调用在 E2E 里一路 201，说明"已退役"和"没人用"都需要机器证据。
- **把旧入口改成域无关的透传**（按比赛 ID 反查域再转）：会绕过
  `resolveDefaultContestAccess` 的默认域边界，属于用清理的名义打开越权口子。
- **让 E2E 跑 `retireLegacyEndpoints: true`**：能做，但会让 37 处测试调用当天全部红，
  属于"一次把未知量全摊开"，不适合塞进 RC 收尾；记录为 0.12 的伴随动作。

## Consequences

- 旧读接口在 0.11 仍是**可达但无生产调用方**的兼容面；下线被推迟到 0.12，且有门禁
  保证它不会悄悄长出新的调用方。
- 两个后台页面改为一次请求拿竞赛详情 + 赛题（少一次往返，且授权口径是管理员而不是
  默认域匿名读）。
- 旧编辑器深链接不再 410 半可用，而是直接进域作答页；`isContest` 分支成为不可达代码，
  与"随 0.12 删除"一起登记在白名单里，删不干净会被陈旧检查拦住。
- `noj-tests` 的 37 处旧路径调用仍是**非生产专属**，它们不构成退役证据；这一点写进
  了门禁输出（"测试引用 N 处仅跑非生产环境"），避免下次又被当成绿灯依据。
