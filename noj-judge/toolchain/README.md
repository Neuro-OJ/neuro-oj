# NOJ WASI SDK v2

本目录维护 WASI SDK 34 的固定构建配置、libc++ 补丁和计量相关组件内容清单。
构建入口为 `../scripts/build-oi-wasi-toolchain.py`，开发、CI 和生产镜像共用。
开发与 CI 通过 `../scripts/build-oi-wasi-toolchain.sh <cache> <work> <output>`
使用与生产相同的固定 Debian 容器；Python 入口也支持直接构建候选产物。

## 修订

- SDK 自带的三个 LLVM 补丁按原始内容保留。
- 标准流缓冲补丁定向回移 LLVM 提交
  `3b7447e00baff23660b49fdcb67ce83a3bf94605`，保留公开流对象 ABI。
- 整数解析保留 locale、进制、符号、范围和流状态处理；优化普通十进制路径，并用
  阈值判断替代宽整数软件乘法。宽字符和自定义迭代器继续使用通用路径。
- 固定源码、SDK 和生成头文件的路径映射，避免不同构建目录改变调试内容和产物摘要。

补丁派生自 LLVM/WASI SDK，遵循上游 Apache-2.0 WITH LLVM-exception 许可；上游
归档中的许可证随 SDK 一同保留。此目录不包含选手源码或正式题目测试数据。

## 构建与校验

`recipe.json` 绑定下载摘要、源码提交、补丁内容和构建参数；`components.json`
绑定固定参数使用的编译器、链接器、资源目录与 wasip1 标准库、头文件。
组件路径相对于 SDK 根目录；C++11 不使用的安装模块路径元数据不参与组件摘要。

构建默认必须匹配已冻结清单；`--record-manifest` 仅供开发新标准时向指定文件记录
候选清单，不能用于生产构建。改变清单或构建结果必须发布新标准，不得覆盖 v2。 SDK
的安装目录不影响编译产物：Worker 将 SDK 路径统一映射为 `/opt/wasi-sdk`。

关闭同步后不保证 C 与 C++ IO 混用的顺序；应按 C++ 标准的非同步流规则使用。
已发生 IO 后切换同步的行为沿用所回移的上游实现；验收固定了刷新后切换的行为。
正常使用 `freopen`、`cin/cout` 和默认同步下的 C/C++ 混用由平台提供兼容性。
