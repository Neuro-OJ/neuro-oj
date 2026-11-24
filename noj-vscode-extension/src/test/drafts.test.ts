import assert from "node:assert/strict";
import test from "node:test";
import { draftKeysToClear } from "../drafts";

const draft = (...parts: string[]) => `neuroOj.draft:${JSON.stringify(parts)}`;

test("只清理当前服务器与当前账号的草稿键", () => {
  const mineA = draft("https://a.example", "u1", "school", "1001", "v1");
  const mineB = draft("https://a.example", "u1", "school", "1002", "v2");
  const otherUser = draft("https://a.example", "u2", "school", "1001", "v1");
  const otherServer = draft("https://b.example", "u1", "school", "1001", "v1");
  const keys = [
    mineA,
    otherUser,
    otherServer,
    mineB,
    "neuroOj.user",
    "neuroOj.domain:https://a.example:u1",
  ];

  assert.deepEqual(draftKeysToClear(keys, "https://a.example", "u1"), [
    mineA,
    mineB,
  ]);
});

test("格式不符合约定或不含账号的草稿键不清理", () => {
  const keys = [
    "neuroOj.draft:not-json",
    `neuroOj.draft:${JSON.stringify({ server: "https://a.example" })}`,
    `neuroOj.draft:${JSON.stringify(["https://a.example"])}`,
    `neuroOj.draft:${JSON.stringify(["https://a.example", 1, "school"])}`,
  ];

  assert.deepEqual(
    draftKeysToClear(keys, "https://a.example", "1"),
    [],
    "账号 id 必须是字符串，不能被数字类型混淆",
  );
});

test("未知账号（空串）不会误删其它账号的草稿", () => {
  const keys = [draft("https://a.example", "u1", "school", "1001", "v1")];

  assert.deepEqual(draftKeysToClear(keys, "https://a.example", ""), []);
});
