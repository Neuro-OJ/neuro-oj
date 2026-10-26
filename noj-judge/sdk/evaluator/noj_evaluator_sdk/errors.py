"""
noj_evaluator_sdk 错误类型。

五类错误码与 Solution host 一一对应（详见 design.md §2）。
"""


class SdkError(Exception):
    """所有 SDK 错误的基类。"""


class SolutionTimeoutError(SdkError):
    """单次 `runner.call()` 超过 `call_timeout_ms`。

    Solution host 进程本身仍存活，可继续下一次调用。
    """


class NotFoundError(SdkError):
    """Solution host 中没有注册指定名称的函数。

    - `fn`：evaluator 请求调用的函数名（由 `SolutionRunner.call()` 填充）。
    - `reason`：host 给出的细分原因——`not_registered`（entry 正常加载但没有该
      函数，即选手缺函数）/ `entry_load_failed`（选手代码语法错误或导入失败）/
      `None`（旧版 solution 镜像未提供）。

    仅 `reason == "not_registered"` 且未被 evaluate.py 捕获时，SDK 会代为写出
    0 分结果（见 runner.py）。
    """

    def __init__(
        self,
        message: str = "",
        fn: "str | None" = None,
        reason: "str | None" = None,
    ) -> None:
        super().__init__(message)
        self.fn = fn
        self.reason = reason


class RejectedError(SdkError):
    """参数或返回值包含不被允许的类型（如自定义类、函数、socket）。"""


class SystemError(SdkError):
    """host 内部错误、judge IPC 通道断开等不可恢复错误。"""


class ConnectionError(SystemError):
    """stdin/stdout IPC 通道连接错误（典型场景：Solution host 进程崩溃）。"""