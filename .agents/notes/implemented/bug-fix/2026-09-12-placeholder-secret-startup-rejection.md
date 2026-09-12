# Agent Note: 启动期拒绝占位密钥并收敛黑名单为单一事实源

Status: implemented

## Problem

`.env.prod.example` 的 `JWT_SECRET=change-me-to-a-random-string-at-least-32-chars` 长度 46 ≥ `MIN_JWT_SECRET_LENGTH`(32)，**能通过 main.ts 的长度校验**；compose 的 `${JWT_SECRET:?}` 只拦空值。于是"照文档复制模板后直接 up -d"会以**公开已知的密钥**上线，可伪造任意用户（含 admin）的 token。占位值兜底此前只存在于 `scripts/deploy/deploy.sh`（shell 实现），手动部署路径完全没有防线；`noj-core/scripts/check-env.ts` 另有一份 TS 黑名单，但只是巡检、不在启动路径。

## Decision

1. 新增 `src/shared/security/secret-placeholders.ts` 作为**单一事实源**（`PLACEHOLDER_PATTERNS` / `isPlaceholderSecret` / `describePlaceholderSecret`），`main.ts` 与 `check-env.ts` 共用——消除两处黑名单漂移。
2. `main.ts` 对 `JWT_SECRET` 与 `TFA_ENCRYPTION_KEY` 在长度校验之外**再加占位值校验**，命中即 exit 1。
3. `.env.prod.example` 与 `noj-core/.env.example` 的密钥项改为**留空**（占位文案本身会被拉黑），并在模板头部推荐 `deploy.sh install`（它会自动生成强随机密钥）。
4. `compose` 头部与模板注释写明生成命令（`openssl rand -base64 48`）。

## Alternatives considered

- 只改模板不改代码：下一个模板仍可能写出"长度恰好合格"的占位值。
- 用熵/字符集启发式判断"是否随机"：误杀风险高（固定测试密钥会被拒）。
- 在测试环境放行：CI/E2E 的固定密钥本来就不命中黑名单（`test` 为整体匹配），无需特例。

## Consequences

使用公开模板直接部署将**启动失败**（而非静默上线），错误信息给出生成命令。`tests/shared/security/secret-placeholders.test.ts` 覆盖历史占位值拦截与真实随机密钥/固定测试密钥不误杀。
