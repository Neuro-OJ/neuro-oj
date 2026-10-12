# Agent Note: 出错提交的错误信息不可见

Status: implemented

## Problem

线上提交 `sub-k254fcbh`（LLM 题）创建后 24ms 即落为 `error`。管理员打开详情页看不到任何原因，有两层原因：

1. `noj-ui/pages/submissions/[id].vue` 的输出区只在 `status === 'finished'` 时渲染。后端虽已向 owner/admin 返回 `result.output`，但 error 提交的输出在 UI 上永远不展示。
2. 评测机在启动容器前失败（白名单复验、支持包/artifact 获取或校验）时，一律走 `JudgeResult::error()`，回传固定的「系统内部错误 (submission: …)」。真实原因只写进 judge 日志，管理员必须登录服务器翻日志。

## Decision

- **noj-judge**：新增 `PublicJudgeError(&'static str)`。启动前的平台侧失败以它为根错误，详细原因以 anyhow context 附加在外层（`Display` 不变，日志与既有断言照旧）。`JudgeResult::from_error()` 通过 `downcast_ref` 取出固定的公开文案回传；其余错误仍退化为通用「系统内部错误」。覆盖的场景：镜像不在白名单、evaluator 命令不在白名单、题目需要联网但 `JUDGE_ALLOW_EVALUATOR_NETWORK=false`、支持包获取/SHA-256 校验失败、artifact 获取/校验失败。
- **noj-ui**：输出区抽为 `components/submission/SubmissionOutputPanel.vue`，`finished` 与 `error` 两种终态都展示；error 时默认展开、标题为「错误信息」。已登录但无权查看时，提示文案改为「仅提交者与管理员可查看评测输出」，不再误导用户去登录。

## Alternatives considered

- 直接把 anyhow 错误全文回传：会把镜像名、下载 URL、内部路径暴露给做题人（提交者本人同样能看到 output），违背 `JudgeResult::error()` 隐藏内部细节的初衷。用 `&'static str` 在类型上保证公开文案不含动态内容。
- 仅为管理员单独提供日志查询接口：改动面大，且对提交者本人无帮助；平台配置类错误告知提交者「与代码无关、请联系管理员」本身就有价值。

## Consequences

- 公开文案对提交者可见，所以只写类别与处理建议，不含具体镜像名、命令或 URL；具体值仍需按提交 ID 查 judge 日志。
- 新增启动前失败路径时，若希望用户能看到原因，需要显式使用 `PublicJudgeError(...).with_detail(...)`；否则默认隐藏。
- 已落库的历史 error 提交 output 仍是「系统内部错误」，重测后才会得到新文案。
