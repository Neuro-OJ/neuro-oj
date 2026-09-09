/**
 * 限流与密码爆破锁定 E2E（独立 rate-limit 域）。
 *
 * 本域对应的 CI job（e2e-rate-limit）显式设置：
 * - `RATE_LIMIT_ENABLED=true`（默认 E2E 栈关闭限流）
 * - `RATE_LIMIT_LOGIN_IP_MAX=1000` / `RATE_LIMIT_LOGIN_ACC_MAX=1000`
 *   （放宽窗口限流，让「连续失败达到阈值锁定」成为唯一触发路径）
 * - `RATE_LIMIT_LOGIN_BACKOFF_SEC=0`（去掉失败退避等待）
 *
 * 因此这里断言的是**服务端真实锁定状态**：
 * 1. 连续错误密码都返回 401（不是 429 限流）；
 * 2. 达到阈值后，用**正确密码**登录也被拒，且提示账号已锁定；
 * 3. Redis 中存在 `loginlock:<username>` 标记（不依赖响应文案）。
 *
 * 参考实现：noj-core `src/domains/identity/services/security/loginThrottle.ts`。
 */

import {
  apiPost,
  e2eTest,
  isE2E,
  registerUser,
  TEST_PASSWORD,
} from "../helper.ts";

const LOCK_THRESHOLD = Number(
  Deno.env.get("RATE_LIMIT_LOGIN_LOCK_THRESHOLD") ?? "10",
);

e2eTest(
  "[e2e/rate-limit] 连续错误密码触发账号锁定（正确密码也被拒）",
  async () => {
    if (!isE2E) return;
    const ts = Date.now().toString(36);
    const username = `rl_${ts}`;
    await registerUser(username, `${username}@test.com`, TEST_PASSWORD);

    for (let i = 0; i < LOCK_THRESHOLD; i++) {
      const res = await apiPost("/api/v1/auth/login", {
        login: username,
        password: `WrongPass${i}`,
      });
      if (res.status === 429) {
        throw new Error(
          `第 ${i + 1} 次失败即被 429 限流，无法验证锁定阈值` +
            "（请确认 e2e-rate-limit job 已放宽 RATE_LIMIT_LOGIN_ACC_MAX / IP_MAX）",
        );
      }
      if (res.status !== 401) {
        throw new Error(`第 ${i + 1} 次错误密码应返回 401，实际 ${res.status}`);
      }
    }

    // 锁定后正确密码也必须被拒，且响应体提示锁定
    const locked = await apiPost("/api/v1/auth/login", {
      login: username,
      password: TEST_PASSWORD,
    });
    if (locked.status !== 401) {
      throw new Error(`锁定期内正确密码应返回 401，实际 ${locked.status}`);
    }
    const body = JSON.stringify(locked.body ?? "");
    if (!body.includes("锁定")) {
      throw new Error(
        `锁定响应应提示账号已锁定，实际 ${body.slice(0, 200)}`,
      );
    }

    // 直接验证 Redis 锁定标记（服务端状态，不依赖文案）
    const cmd = new Deno.Command("docker", {
      args: [
        "exec",
        "noj-e2e-redis",
        "redis-cli",
        "EXISTS",
        `loginlock:${username.toLowerCase()}`,
      ],
    });
    const { stdout, success } = await cmd.output();
    if (!success) {
      throw new Error("docker exec noj-e2e-redis 失败，无法验证锁定标记");
    }
    const exists = new TextDecoder().decode(stdout).trim();
    if (exists !== "1") {
      throw new Error(`Redis 中缺少 loginlock 标记（EXISTS 返回 ${exists}）`);
    }
    console.log("  ✓ 账号锁定已生效（401 + loginlock 标记）");
  },
);
