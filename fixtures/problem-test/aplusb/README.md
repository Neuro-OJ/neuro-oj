# problem test 夹具：A+B

`noj-cli problem test` 的 CI 门禁夹具（合成题，不含题库内容）。

```bash
noj-cli problem test fixtures/problem-test/aplusb --judge-bin noj-judge/target/debug/noj-judge
```

`submissions/expect.json` 约定：`good` 满分、`wrong` 低于 50、`empty` 0 分。
