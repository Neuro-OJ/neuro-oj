# scripts/ — 脚本总览

Neuro OJ 仓库根目录的脚本统一存放点。所有脚本以 `bash scripts/<dir>/<name>.sh`
方式调用。

## 目录结构

```
scripts/
├── README.md              # 本文件(索引)
│
├── dev/                   # 🆕 本地开发运行
│   ├── README.md          #   详细开发指南 + FAQ
│   ├── env.example        #   noj-core 环境变量模板
│   ├── install-deps.sh    #   检测/安装前置依赖
│   ├── start-infra.sh     #   启动 PostgreSQL + Redis
│   ├── stop-infra.sh      #   停止基础设施
│   ├── start-core.sh      #   启动 noj-core(后台)
│   ├── stop-core.sh
│   ├── start-ui.sh        #   启动 noj-ui(后台)
│   ├── stop-ui.sh
│   ├── start-judge.sh     #   启动 noj-judge(后台)
│   ├── stop-judge.sh
│   ├── start-all.sh       #   一键启动
│   ├── stop-all.sh
│   ├── status.sh          #   查看运行状态
│   └── logs/              #   日志 + PID 文件目录
│
├── db/                    # 数据库脚本
│   ├── migrate.sh         #   运行 Drizzle 迁移
│   └── seed.sh            #   种子数据(题库/分类/管理员)
│
├── build/                 # 构建脚本
│   └── build-packages.sh  #   构建题目支持包 zip
│
└── e2e/                   # 跨模块 E2E 测试
    ├── setup.sh           #   启动 E2E 环境
    ├── teardown.sh        #   停止 E2E 环境
    ├── core.sh            #   运行 noj-core E2E
    ├── judge.sh           #   运行 noj-judge E2E
    └── run-all.sh         #   E2E 一键运行
```

## 按使用场景速查

| 我想...                                  | 使用                                                            |
| ---------------------------------------- | --------------------------------------------------------------- |
| **首次启动整套开发环境**                 | `bash scripts/dev/start-all.sh`                                 |
| **查看当前运行状态**                     | `bash scripts/dev/status.sh`                                    |
| **停止所有模块**                         | `bash scripts/dev/stop-all.sh`                                  |
| **单独重启某个模块**                     | `bash scripts/dev/stop-{core,ui,judge}.sh && bash scripts/dev/start-{core,ui,judge}.sh` |
| **首次环境配置**                         | `bash scripts/dev/install-deps.sh`                              |
| **复制环境变量模板**                     | `cp scripts/dev/env.example noj-core/.env`                      |
| **手动初始化数据库**                     | `bash scripts/db/migrate.sh && bash scripts/db/seed.sh`         |
| **手动构建题目支持包**                   | `bash scripts/build/build-packages.sh`                          |
| **跑跨模块 E2E 测试**                    | `bash scripts/e2e/run-all.sh`                                   |

## 与原 `deno task` / `cargo run` 的关系

`scripts/dev/*.sh` **不替代**原生命令,只是封装了"后台守护 + PID 管理 + 日志
归集"的运维能力。需要前台运行/调试时仍推荐直接使用:

```bash
cd noj-core  && deno task dev
cd noj-ui    && deno task dev
cd noj-judge && cargo run
```

详细开发指南见 [`dev/README.md`](dev/README.md)。