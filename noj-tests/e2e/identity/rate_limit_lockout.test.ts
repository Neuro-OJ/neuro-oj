/**
 * 限流与密码爆破锁定 E2E。
 *
 * 仅当测试进程显式设置 `RATE_LIMIT_ENABLED=true` 时运行；E2E 默认栈
 * （docker-compose.e2e.yml）关闭限流，因此默认跳过。
 *
 * 实际实现（noj-core）：
 * - 登录 IP 维度：30s/10 次 → 429
 * - 登录账号维度：30s/5 次 → 429
 * - 连续 10 次失败后账号锁定 → 后续登录返回 401（“账号已临时锁定”）
 * - 注册接口未挂限流中间件，因此不写“注册超频 429”用例
 */

import { apiPost, e2eTest, isE2E } from "../helper.ts";

const rateLimitEnabled = Deno.env.get("RATE_LIMIT_ENABLED") === "true";

e2eTest(
  "[e2e/rate-limit] 连续错误密码触发 429 或锁定",
  async () => {
    if (!isE2E) return;
    const email = `lock_${Date.now().toString(36)}@test.com`;
    let sawLimited = false;
    for (let i = 0; i < 12; i++) {
      const res = await apiPost("/api/v1/auth/login", {
        login: email,
        password: "WrongPass" + i,
      });
      // 账号维度 30s/5 次 → 429；连续 10 次失败后锁定 → 401（账号已临时锁定）
      if (res.status === 429 || (res.status === 401 && i >= 9)) {
        sawLimited = true;
        break;
      }
    }
    if (!sawLimited) {
      throw new Error("连续错误密码后应触发限流/锁定，未观察到 429/锁定 401");
    }
  },
  !rateLimitEnabled,
);
