import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  EDUCATION_WRITE_LIMIT,
  enforceEducationWriteRateLimit,
} from "../../index.ts";
import { connectRedis, getRedis } from "../../../../shared/mq/connection.ts";
import { RateLimitedError } from "../../../../shared/base/errors.ts";

Deno.test({
  name: "教学写限流 helper：真实Redis第121次429，域和账号窗口独立",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const before = Deno.env.get("RATE_LIMIT_ENABLED"),
      actor = crypto.randomUUID(),
      other = crypto.randomUUID();
    const slug = `education-${crypto.randomUUID()}`, second = `${slug}-b`;
    await connectRedis();
    const redis = getRedis();
    const keys = [`${slug}:${actor}`, `${slug}:${other}`, `${second}:${actor}`]
      .map((x) => `ratelimit:hardening:education-write:${x}`);
    Deno.env.set("RATE_LIMIT_ENABLED", "true");
    try {
      assertEquals(EDUCATION_WRITE_LIMIT, { windowSec: 60, max: 120 });
      for (let n = 0; n < 120; n++) {
        await enforceEducationWriteRateLimit(slug, actor);
      }
      const blocked = await assertRejects(
        () => enforceEducationWriteRateLimit(slug, actor),
        RateLimitedError,
      );
      assertEquals(blocked.headers?.["X-RateLimit-Limit"], "120");
      assertEquals(Number(blocked.headers?.["Retry-After"]) > 0, true);
      await enforceEducationWriteRateLimit(second, actor);
      await enforceEducationWriteRateLimit(slug, other);
      assertEquals(await Promise.all(keys.map((key) => redis.get(key))), [
        "121",
        "1",
        "1",
      ]);
    } finally {
      await redis.del(...keys);
      if (before === undefined) {
        Deno.env.delete("RATE_LIMIT_ENABLED");
      } else Deno.env.set("RATE_LIMIT_ENABLED", before);
    }
  },
});
