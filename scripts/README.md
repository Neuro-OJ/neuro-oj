# scripts/ — 脚本总览

Neuro OJ 仓库根目录的脚本统一存放点。所有脚本以 `bash scripts/<dir>/<name>.sh`
方式调用。

## 目录结构

```
scripts/
├── README.md              # 本文件(索引)
│
├── dev/                   # 本地开发编排
│   ├── README.md          #   详细开发指南 + FAQ
│   ├── devtool.sh         #   单文件编排入口（install-deps / init-env / start / stop / status）
│   ├── env.example        #   noj-core 环境变量模板
│   ├── logs/              #   日志 + PID 文件目录
│   └── locks/             #   devtool 同工具防双开锁
│
└── e2e/                   # 跨模块 E2E 测试
    ├── setup.sh           #   启动 E2E 环境
    ├── check-setup.sh     #   检查 E2E SDK 镜像刷新与失败传播
    ├── teardown.sh        #   停止 E2E 环境
    ├── core.sh            #   运行 noj-core E2E
    ├── judge.sh           #   运行 noj-judge E2E
    └── run-all.sh         #   E2E 一键运行
```

## 按使用场景速查

| 我想...                                  | 使用                                                            |
| ---------------------------------------- | --------------------------------------------------------------- |
| **首次启动整套开发环境**                 | `bash scripts/dev/devtool.sh install-deps && bash scripts/dev/devtool.sh init-env && bash scripts/dev/devtool.sh start` |
| **查看当前运行状态**                     | `bash scripts/dev/devtool.sh status`（加 `--json` 结构化输出）  |
| **停止所有模块**                         | `bash scripts/dev/devtool.sh stop`                              |
| **单模块启动**                           | `bash scripts/dev/devtool.sh start <core\|ui\|judge\|infra>`    |
| **单模块重启**                           | `bash scripts/dev/devtool.sh stop <core\|ui\|judge> && bash scripts/dev/devtool.sh start <core\|ui\|judge>` |
| **更新环境变量模板（保留自定义）**       | `bash scripts/dev/devtool.sh init-env --merge`                  |
| **手动初始化数据库**                     | `cd noj-core && deno task db:migrate`（初始化见 `deno task dev-setup`） |
| **手动构建题目包**                       | `cd noj-core && deno task problems:build`                              |
| **跑跨模块 E2E 测试**                    | `bash scripts/e2e/run-all.sh`                                   |

devtool.sh 子命令完整列表：`bash scripts/dev/devtool.sh help` 或 `devtool.sh <子命令> --help`。

## 与原 `deno task` / `cargo run` 的关系

`scripts/dev/devtool.sh` **不替代**原生命令,只是封装了"后台守护 + PID 管理 + 日志
归集"的运维能力。需要前台运行/调试时仍推荐直接使用:

```bash
cd noj-core  && deno task dev
cd noj-ui    && deno task dev
cd noj-judge && cargo run
```

详细开发指南见 [`dev/README.md`](dev/README.md)。
