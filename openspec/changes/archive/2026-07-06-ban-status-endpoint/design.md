## Context

PR #108 (`admin-ip-blacklist`) 已落地 IP 黑名单中间件和用户封禁逻辑，但存在三个设计缺陷：

1. **死锁**：`banlistMiddleware` 挂载在 `app.use("/api/v1/*")` 无任何白名单，被封 IP 用户的 GET 请求全部 403，连 `/api/v1/auth/logout` 都不可达。
2. **`getBannedRanges()` 不过滤 `expires_at`**：过期 IP 封禁条目无法自动失效，只在缓存 60s TTL 区间内有效——缓存过期后重新拉全表仍会命中。
3. **UX 缺失**：IP 被封无前端 UI 提示（`IP_BLACKLISTED` 只有后端错误码）；用户被封的错误信息通过 URL 参数 `?banned=1&reason=...&until=...` 逐个页面传递，逻辑散落在 `login.vue`、`useAuth.ts`、`authMiddleware` 三处。

本设计引入 ban-status 端点，将"告知被封状态"与"阻止操作"解耦为独立关注点。

## Goals / Non-Goals

**Goals:**
- 提供不受任何中间件拦截的 `GET /api/v1/auth/ban-status` 端点
- 前端在布局级一次性获取封禁状态并渲染全局 UI
- 修复 `getBannedRanges()` 中 `expires_at` 未过滤的问题
- 调整 `banlistMiddleware` 为仅拦截写操作，保持防御纵深

**Non-Goals:**
- 修改 `ip_bans` 或 `users` 表结构（数据库 schema 不变）
- 新增 WebSocket 实时推送
- 引入自动解封 cron 任务
- 添加申诉/解封申请流程

## Decisions

### 1. 统一中间件策略：方法限制 + 最小白名单

`banlistMiddleware` 和 `authMiddleware`（封禁检查部分）采用**同一模式**：

```
GET/HEAD/OPTIONS → 直接放行（被封用户可浏览、查状态、登出）
POST/PUT/PATCH/DELETE → 检查封禁状态，命中抛 403
```

这意味着 ban-status（GET 端点）**天然不受任何中间件拦截**，不需要特殊挂载位置或路径白名单。

需要豁免的写操作有两条——被封用户必须能登出，也必须能输入密码以获取封禁提示。因此 `BAN_WHITELIST` 为：

```typescript
const BAN_WHITELIST = [
  "/api/v1/auth/logout",  // 被封用户仍可登出
  "/api/v1/auth/login",   // 被封用户可输入密码，由 loginUser service 返 403 + USER_BANNED
];
```

`banlistMiddleware` 同理，维护相同的最小白名单——IP 被封用户也应能登出和登录（`loginUser` 的 IP 封禁检查已足够阻止通过密码验证）。

**替代方案（已否决）**：
- 扩展 `/me` 端点（增加 IP 封禁信息）→ 语义混淆，`/me` 的职责是用户信息而非安全状态
- 完全移除白名单仅靠方法限制 → logout 和 login 都是 POST 写操作，方法限制会误拦这两个正当需求

### 2. ban-status 端点设计

```
GET /api/v1/auth/ban-status
```

因为两个中间件的封禁检查都只拦截写操作（Decision 1），ban-status 作为 GET 端点**不需要任何特殊挂载或路径白名单**。它就是一个普通的 GET 路由，挂在 `app.route("/api/v1", authRouter)` 下即可。

### 3. getBannedRanges() 修复 expires_at 过滤

```typescript
export async function getBannedRanges(): Promise<string[]> {
  return await getCached("ip_bans:all", async () => {
    const rows = await db.select({ ip_or_cidr: ipBans.ip_or_cidr })
      .from(ipBans);
    const now = new Date().toISOString();
    return rows
      .filter(r => !r.expires_at || r.expires_at > now)
      .map(r => r.ip_or_cidr);
  }, 60_000);
}
```

**理由**：过期条目不应生效。之前"在 service 层不过滤"的设计注释（"避免 service 与 cache key 耦合时间逻辑"）过于谨慎——60s 缓存+过期过滤的组合是标准做法。

### 4. ban-status 响应格式

```json
{
  "ip_banned": true,
  "ip_ban_info": {
    "matched_cidr": "10.0.0.0/8",
    "reason": "滥用服务器",
    "expires_at": null
  },
  "user_banned": true,
  "user_ban_info": {
    "reason": "多次违规提交",
    "until": "2026-07-15T00:00:00.000Z"
  },
  "authenticated": true,
  "user": {
    "id": "uuid",
    "username": "foo",
    "role": "user",
    "must_change_password": false
  }
}
```

- `ip_banned` / `user_banned` 是布尔，前端可直接决定渲染逻辑
- 附带的 `*_info` 提供给 Banner 展示详情
- `authenticated` 避免前端额外调 `/me` 一次
- 不返回敏感信息（如完整 blacklist 条目列表）

### 5. 前端架构：全局 BanBanner + useBanStatus composable

```
app.vue (或 default.vue 布局)
  ├─ onMounted → useBanStatus().fetch()
  ├─ <BanBanner v-if="ipBanned" type="ip" :info="ipBanInfo" />
  ├─ <BanBanner v-if="userBanned" type="user" :info="userBanInfo" />
  └─ <NuxtPage v-if="!blocking" />
```

`useBanStatus.ts`：
```typescript
export function useBanStatus() {
  const ipBanned = ref(false)
  const userBanned = ref(false)
  const ipBanInfo = ref(null)
  const userBanInfo = ref(null)
  const authenticated = ref(false)
  const user = ref(null)

  async function fetch() {
    const res = await $fetch("/api/v1/auth/ban-status")
    // 填充 refs
  }

  return { ipBanned, userBanned, ipBanInfo, userBanInfo, authenticated, user, fetch }
}
```

**替代方案（已否决）**：
- 在 `useAuth.ts` 中集成 ban 状态 → 职责混淆，auth = 认证，ban = 安全状态
- 在每个页面单独调 ban-status → 重复代码，不如布局级一次调用

## Risks / Trade-offs

- **[风险] GET 放行后仍可能有读取攻击** — 被封 IP 可以继续刷 GET（题目列表、排名等）消耗资源 → 缓解：`rateLimitEnv.ts` 已实现 IP 维度登录限流；后续可扩展为通用 GET 限流。GET 放行的安全代价可控——写操作仍全拦截。
- **[风险] ban-status 端点暴露封禁详情** — 攻击者可检查自己被封的原因 → 缓解：只返回**调用者自己**的封禁信息，不需要 token 就能查但仅限自身 IP 维度。攻击者无法枚举他人状态。
- **[风险] 前端 ban-status 调用失败** — JS 加载失败或网络问题时 Banner 不显示 → 缓解：后端写操作中间件是硬兜底，curl 绕过前端直接 POST 仍被拦截。
- **[权衡] 60s 缓存 + UI 更新延迟** — 管理员解封后，被封用户最多等 60s 才能在前端看到变化 → 与现有 system-settings 和 rate-limit 的 TTL 策略一致，可接受。

## Migration Plan

1. 新增 ban-status 端点（无破坏性）
2. 新增前端 `useBanStatus` composable + BanBanner 组件
3. 部署验证 ban-status 正常工作
4. 修改 `banlistMiddleware` + `authMiddleware` 为方法限制模式（GET 放行）
5. 简化 `BAN_WHITELIST` 为仅含 logout
6. 修复 `getBannedRanges()` 过期过滤
7. 删除 `login.vue` 的 `?banned=1` 参数处理
8. 删除 `useAuth.ts` 中散落的 banned 字段传递

**回滚策略**：每一步均可独立回滚——ban-status 是净新增端点，不影响其他路径；中间件行为变更可通过配置回退。

## Open Questions

- 是否需要为 ban-status 端点增加 CORS 特殊处理？（当前 dev 环境 `Access-Control-Allow-Origin: *`，prod 白名单——应不需要额外配置）
- 已登录用户的 ban-status 调用是否需要限流？（ban-status 是轻量查询，60s LRU 缓存后的 DB 查询成本趋近于零）
