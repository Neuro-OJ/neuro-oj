import { assertEquals } from "jsr:@std/assert@^1";
import { scoreFromDb, scoreToDb } from "../../index.ts";
import { isImageInWhitelist, parseImageRef } from "../../../catalog/index.ts";

Deno.test("scoreToDb/scoreFromDb 整分", () => {
  assertEquals(scoreToDb(100), 10000);
  assertEquals(scoreFromDb(10000), 100);
});

Deno.test("scoreToDb/scoreFromDb 小数", () => {
  assertEquals(scoreToDb(99.5), 9950);
  assertEquals(scoreFromDb(9950), 99.5);
});

Deno.test("scoreToDb/scoreFromDb 零分", () => {
  assertEquals(scoreToDb(0), 0);
  assertEquals(scoreFromDb(0), 0);
});

Deno.test("scoreToDb/scoreFromDb 满分", () => {
  assertEquals(scoreToDb(10.0), 1000);
  assertEquals(scoreFromDb(1000), 10);
});

Deno.test("scoreToDb 四舍五入", () => {
  assertEquals(scoreToDb(10.005), 1001);
  assertEquals(scoreToDb(10.004), 1000);
});

// ── isImageInWhitelist 单元测试 ──

const WHITELIST = [
  { image: "noj-judge-cpp:gcc13", mode: "exact" },
  { image: "noj-judge-python", mode: "all_versions" },
  { image: "noj-judge-java:jdk21", mode: "exact" },
];

Deno.test("isImageInWhitelist: exact 模式精确匹配", () => {
  assertEquals(isImageInWhitelist("noj-judge-cpp:gcc13", WHITELIST), true);
});

Deno.test("isImageInWhitelist: exact 模式不匹配返回 false", () => {
  assertEquals(isImageInWhitelist("noj-judge-cpp:gcc14", WHITELIST), false);
  assertEquals(isImageInWhitelist("noj-judge-cpp", WHITELIST), false);
});

Deno.test("isImageInWhitelist: all_versions 模式无标签匹配", () => {
  assertEquals(isImageInWhitelist("noj-judge-python", WHITELIST), true);
});

Deno.test("isImageInWhitelist: all_versions 模式有标签匹配", () => {
  assertEquals(isImageInWhitelist("noj-judge-python:latest", WHITELIST), true);
  assertEquals(isImageInWhitelist("noj-judge-python:v1.0", WHITELIST), true);
  assertEquals(isImageInWhitelist("noj-judge-python:dev", WHITELIST), true);
});

Deno.test("isImageInWhitelist: all_versions 条目标签不影响匹配", () => {
  // 白名单条目本身带标签时，all_versions 模式仍只忽略 tag
  const list = [{ image: "noj-judge-node:18", mode: "all_versions" }];
  assertEquals(isImageInWhitelist("noj-judge-node:20", list), true);
  assertEquals(isImageInWhitelist("noj-judge-node:latest", list), true);
});

Deno.test("isImageInWhitelist: all_versions 保留完整 repository 路径", () => {
  const list = [{
    image: "registry.local/team/noj-judge-python:3.12",
    mode: "all_versions",
  }];
  assertEquals(
    isImageInWhitelist("registry.local/team/noj-judge-python:latest", list),
    true,
  );
  assertEquals(
    isImageInWhitelist("evil.example/other/noj-judge-python:latest", list),
    false,
  );
  assertEquals(
    isImageInWhitelist("noj-judge-python:latest", list),
    false,
  );
});

Deno.test("isImageInWhitelist: 完全不相关的镜像返回 false", () => {
  assertEquals(isImageInWhitelist("ubuntu:latest", WHITELIST), false);
  assertEquals(isImageInWhitelist("evil-image:latest", WHITELIST), false);
});

Deno.test("isImageInWhitelist: 空白名单返回 false", () => {
  assertEquals(isImageInWhitelist("any-image", []), false);
});

// ── digest 语义（2026-09-12 架构评审 §4.4）──
// tag 可变（latest 被覆盖 / 同名 tag 重新推送），因此白名单登记 digest 后
// 必须按 digest 匹配，否则"跑的还是当初审核过的镜像"无法保证。

const DIGEST_A =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const DIGEST_B =
  "sha256:2222222222222222222222222222222222222222222222222222222222222222";

Deno.test("parseImageRef: 解析 repository / tag / digest", () => {
  assertEquals(parseImageRef("noj-judge-python"), {
    repository: "noj-judge-python",
    tag: null,
    digest: null,
  });
  assertEquals(parseImageRef("noj-judge-python:v1"), {
    repository: "noj-judge-python",
    tag: "v1",
    digest: null,
  });
  assertEquals(parseImageRef(`noj-judge-python@${DIGEST_A}`), {
    repository: "noj-judge-python",
    tag: null,
    digest: DIGEST_A,
  });
  // registry 端口不能被当成 tag
  assertEquals(parseImageRef(`registry.example:5000/team/img:v2@${DIGEST_A}`), {
    repository: "registry.example:5000/team/img",
    tag: "v2",
    digest: DIGEST_A,
  });
});

Deno.test("isImageInWhitelist: 白名单登记 digest 后按 digest 匹配", () => {
  const list = [{
    image: `noj-judge-python@${DIGEST_A}`,
    mode: "all_versions",
  }];
  // 携带同一 digest（任意 tag）→ 通过
  assertEquals(
    isImageInWhitelist(`noj-judge-python:v9@${DIGEST_A}`, list),
    true,
  );
  assertEquals(isImageInWhitelist(`noj-judge-python@${DIGEST_A}`, list), true);
  // 未携带 digest（只给 tag）→ 拒绝：无法证明是审核过的那个镜像
  assertEquals(isImageInWhitelist("noj-judge-python:latest", list), false);
  assertEquals(isImageInWhitelist("noj-judge-python", list), false);
  // digest 不同（同名 tag 被重新推送）→ 拒绝
  assertEquals(
    isImageInWhitelist(`noj-judge-python:latest@${DIGEST_B}`, list),
    false,
  );
});

Deno.test("isImageInWhitelist: 未登记 digest 时保持历史语义（向后兼容）", () => {
  // 存量白名单条目没有 digest，不能因此全部失效
  assertEquals(isImageInWhitelist("noj-judge-python:latest", WHITELIST), true);
});
