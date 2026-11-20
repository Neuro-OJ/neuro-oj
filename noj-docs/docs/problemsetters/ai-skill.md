# AI 辅助出题（Skill）

> 给 AI 编码助手（Claude Code、Codex 等）装上 NOJ 出题 Skill，让它按「模板 →
> 评测脚本 → 参考解答 → 本地验题 → lint → 打包上传」的固定流程出题，并主动规避
> 分数刻度、隐藏用例泄露、资源限制、LLM 调用预算等常见坑。

## 安装

Skill 随 `noj-cli`
分发，不依赖平台源码仓库。在你出题的目录（题目仓库根目录或任意 工作目录）执行：

```bash
noj-cli problem skill            # 写入当前目录
noj-cli problem skill ~/my-problems
```

命令会写出两份相同的 Skill：

| 位置                                 | 读取方                                       |
| ------------------------------------ | -------------------------------------------- |
| `.agents/skills/noj-problem-setter/` | 遵循 `.agents/skills` 约定的助手（如 Codex） |
| `.claude/skills/noj-problem-setter/` | Claude Code                                  |

- 已安装且内容一致时提示「已是最新」；
- 已存在但内容不同（例如你改过，或 noj-cli 升级后 Skill 有更新）时**不会覆盖**，
  退出码 1；确认后加 `--force` 整体替换（会先删除旧目录）；
- `--json` 输出机器可读结果。

升级 noj-cli 后重新执行一次 `noj-cli problem skill --force` 即可获得新版 Skill。

## Skill 做什么

助手在出题目录工作时会自动加载 Skill（也可以直接让它「按 noj-problem-setter
出一道题」）。Skill 约束的流程与本站文档一致：

1. **选题型**：代码题、预测提交题、LLM 工程题、客观题、界面题，对应
   `problem init --template` 的五个模板；
2. **生成模板并先跑通**：`noj-cli problem init <slug> --template <name>` 后立刻
   `noj-cli problem test`，确认环境就绪，见[本地验题 · 从模板起步](local-test.md#从模板起步)；
3. **改写题面与接口**：题面是选手唯一的规则来源，`template.py` 保持未实现；
4. **改写评测脚本**：选手侧错误只让该用例失败，评测脚本自身错误上抛；
5. **写数据与参考解答**：满分解、错解、空解与 `expect.json`；
6. **验题与校验**：`problem test` 断言全部满足、`problem lint --strict` 零发现；
7. **打包与上传**：`problem pack` / `problem push`，默认只建草稿。

Skill 还内置了常见坑速查与验题失败排查表，以及各题型的专属约束（例如预测题不能
配置 LLM、客观题 `answer` 总是数组、界面题空参数必须能评测）。

## 使用边界

- **不搬运真实题库内容**：Skill 明确要求示例、题面、数据与解答全部原创合成，
  只借鉴题型结构；
- **不代管凭据**：LLM 题需要真实网关验证时，网关地址与评测 token 由你本人提供；
- **不擅自发布**：`push --publish` 只在你明确要求时执行；
- 助手写出的题目同样要经过你审阅：Skill 让流程可验证，但题目质量与原创性仍由
  出题人负责。

## 维护

Skill 的事实源在平台仓库 `noj-cli/skills/noj-problem-setter/`（`SKILL.md` 与
`references/`），由 `noj-cli/src/problem/gen-skill.ts` 嵌入 noj-cli 单二进制；
CI 门禁检查嵌入内容与事实源一致。
