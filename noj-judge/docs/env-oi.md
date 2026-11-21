# OI / go-judge / WASI 环境变量

> 通用变量见 [env.md](env.md)。这一组只由 Worker
> 侧配置提供，**不从题目消息读取**。

| 变量                               | 默认值                  | 说明                                                                                   |
| ---------------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `JUDGE_OI_IMAGE`                   | `noj-oi-cpp`            | OI C/C++ 固定编译/运行镜像；必须以 `JUDGE_IMAGE_PREFIX` 开头，不从题目消息读取         |
| `JUDGE_GO_JUDGE_URL`               | 未设置                  | 生产 OI native 编译/运行服务的 HTTPS/HTTP 地址；设置后 native 任务不在本机 Docker 执行 |
| `JUDGE_GO_JUDGE_TOKEN`             | 未设置                  | go-judge 服务认证 token，通过 `X-Auth-Token` 发送                                      |
| `JUDGE_GO_JUDGE_RESOURCE_CAPACITY` | `2`                     | 跨 Worker 的 go-judge 资源租约槽位数；所有远端 OI 子任务共享该上限                     |
| `JUDGE_GO_JUDGE_RESOURCE_TTL_MS`   | `660000`                | go-judge 资源租约 TTL（毫秒，最小 660000）；Worker 崩溃后由 Redis 自动回收             |
| `JUDGE_GO_JUDGE_RESOURCE_WAIT_MS`  | `300000`                | 等待远端资源槽位的最长时间（毫秒）                                                     |
| `JUDGE_GO_JUDGE_RESOURCE_KEY`      | `noj:judge:oi:go-judge` | 资源租约 Redis 有序集合 key（只能使用无空格控制字符的短 key）                          |
| `JUDGE_WASI_CC`                    | `clang`                 | WASM C99 编译器固定路径；只由 Worker 配置提供                                          |
| `JUDGE_WASI_CXX`                   | `clang++`               | WASM C++11 编译器固定路径；只由 Worker 配置提供                                        |
| `JUDGE_WASI_TARGET`                | `wasm32-wasip1`         | WASI 编译 target；必须与 Worker 的 Wasmtime/WASI SDK 匹配                              |
| `JUDGE_WASI_SYSROOT`               | 未设置                  | 可选的固定 WASI sysroot 路径，不从题目消息读取                                         |
| `JUDGE_WASI_TESTLIB_INCLUDE`       | 未设置                  | 可选的固定 testlib 头文件目录；WASM checker 编译时使用                                 |

## 相关位置

| 内容                                              | 位置                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 运行时实现（WASM 执行、编译、静态分析、资源租约） | `src/oi/`（`wasm*.rs`、`go_judge.rs`、`resource_lease.rs`）                             |
| OI C/C++ 镜像                                     | `docker/oi-cpp/Dockerfile`，构建 `docker build -t noj-oi-cpp docker/oi-cpp`             |
| WASI 工具链与 recipe                              | [`../toolchain/README.md`](../toolchain/README.md)、`scripts/build-oi-wasi-toolchain.*` |
| 自检脚本                                          | `scripts/check-oi-wasi-toolchain.sh`、`scripts/check-oi-wasi-image.sh`                  |

`JUDGE_GO_JUDGE_*` 全部一致才能让多 Worker 共享同一租约集合；容量与 TTL 不同步会
出现槽位泄漏或并发超卖。
