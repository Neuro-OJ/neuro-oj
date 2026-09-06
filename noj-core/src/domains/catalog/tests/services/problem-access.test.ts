/**
 * resolveProblemAccess 判定矩阵测试（纯函数，无 DB）。
 *
 * 覆盖 spec §5.1 的全部档位：
 * admin / owner / 竞赛上下文（允许与拒绝，均不回退 public）/ public / denied。
 */
import { assertEquals } from "jsr:@std/assert@^1";

import { resolveProblemAccess } from "../../services/problem-access.ts";

const priv = { id: "p1", visibility: "private", owner_id: "u-owner" };
const pub = { id: "p2", visibility: "public", owner_id: "u-owner" };

Deno.test("problem-access: admin 可读任意题（含 private）", () => {
  assertEquals(
    resolveProblemAccess(priv, { viewerId: "u-x", isAdmin: true }).mode,
    "admin",
  );
  assertEquals(
    resolveProblemAccess(priv, { viewerId: "u-x", isAdmin: true }).allowed,
    true,
  );
});

Deno.test("problem-access: owner 可读自己的 private 题", () => {
  assertEquals(
    resolveProblemAccess(priv, { viewerId: "u-owner", isAdmin: false }).mode,
    "owner",
  );
});

Deno.test("problem-access: 非 owner 非上下文读 private 题 → denied", () => {
  assertEquals(
    resolveProblemAccess(priv, { viewerId: "u-x", isAdmin: false }).mode,
    "denied",
  );
});

Deno.test("problem-access: 匿名读 public 题 → public", () => {
  assertEquals(
    resolveProblemAccess(pub, { viewerId: null, isAdmin: false }).mode,
    "public",
  );
});

Deno.test("problem-access: 携带允许的竞赛上下文读 private 题 → contest", () => {
  assertEquals(
    resolveProblemAccess(priv, {
      viewerId: "u-x",
      isAdmin: false,
      contestAccess: { contestId: "c1", allowed: true, running: true },
    }).mode,
    "contest",
  );
});

Deno.test("problem-access: 携带拒绝的竞赛上下文读 public 题 → denied（防伪造上下文）", () => {
  assertEquals(
    resolveProblemAccess(pub, {
      viewerId: "u-x",
      isAdmin: false,
      contestAccess: { contestId: "c1", allowed: false, running: true },
    }).mode,
    "denied",
  );
});

Deno.test("problem-access: owner 优先级高于竞赛拒绝上下文", () => {
  assertEquals(
    resolveProblemAccess(priv, {
      viewerId: "u-owner",
      isAdmin: false,
      contestAccess: { contestId: "c1", allowed: false, running: false },
    }).mode,
    "owner",
  );
});
